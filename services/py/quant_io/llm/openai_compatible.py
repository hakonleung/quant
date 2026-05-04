"""Generic OpenAI-compatible :class:`LLMClient` adapter.

DeepSeek, Moonshot, Doubao, OpenAI itself, and most domestic Chinese
LLM endpoints all expose the same chat-completions surface with
``response_format={"type":"json_object"}``. We drive every one of them
through this single adapter and inject the differences (``base_url``,
``model``, ``api_key``) at construction time from
:data:`quant_io.llm.providers.LLM_PROVIDERS`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from quant_core.errors import QuantError

if TYPE_CHECKING:
    from openai import OpenAI

    from quant_io.llm.providers import WebSearchKind


_DEFAULT_TIMEOUT_SEC: Final[float] = 60.0


class OpenAiCompatibleLlmClient:
    """JSON-output chat client for any OpenAI-compatible endpoint."""

    __slots__ = ("_client", "_model", "_provider", "_web_search_kind")

    def __init__(
        self,
        *,
        provider_name: str,
        base_url: str,
        model: str,
        api_key: str,
        timeout_sec: float = _DEFAULT_TIMEOUT_SEC,
        client: OpenAI | None = None,
        web_search_kind: WebSearchKind = "moonshot_tool",
    ) -> None:
        self._provider = provider_name
        self._model = model
        self._web_search_kind = web_search_kind
        if client is not None:
            # Test override — caller wired a stub OpenAI-shaped client.
            self._client = client
            return
        from openai import OpenAI  # imported lazily so tests don't pay the cost

        self._client = OpenAI(
            api_key=api_key,
            base_url=base_url.rstrip("/"),
            timeout=timeout_sec,
        )

    @property
    def name(self) -> str:
        return self._provider

    @property
    def model(self) -> str:
        return self._model

    def complete_with_web_search(
        self,
        *,
        system: str,
        user: str,
        max_searches: int,
    ) -> str:
        """Run a single research turn against the configured web-search
        backend and return the assistant's reply as plain text.

        Two backends are supported, selected by ``web_search_kind`` at
        construction time:

        * ``moonshot_tool`` — Kimi ``$web_search`` builtin_function tool
          loop. The model emits ``tool_calls``; we echo them back as
          ``role="tool"`` messages whose content is the verbatim
          ``arguments`` string (Moonshot performs the search server-side
          and folds results into the next assistant turn). Loop stops on
          ``finish_reason="stop"`` or when ``max_searches`` is exhausted.
        * ``dashscope_extra_body`` — DashScope (Qwen) single chat call
          with ``extra_body={"enable_search": True}``; the platform
          handles search transparently. ``max_searches`` is ignored on
          this path (DashScope does not expose a per-call budget).

        The reply is *plain analyst text*, not JSON — caller is expected
        to feed it through a downstream summariser.
        """
        if max_searches <= 0:
            raise QuantError(
                "LLM_FAILED",
                "max_searches must be a positive integer",
                {"max_searches": max_searches},
            )
        if self._web_search_kind == "dashscope_extra_body":
            return self._complete_with_dashscope_search(system=system, user=user)
        return self._complete_with_moonshot_tool_loop(
            system=system, user=user, max_searches=max_searches
        )

    def _complete_with_dashscope_search(self, *, system: str, user: str) -> str:
        try:
            response = self._client.with_options(timeout=240.0).chat.completions.create(
                model=self._model,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                extra_body={"enable_search": True},
            )
        except Exception as exc:
            raise QuantError(
                "LLM_FAILED",
                f"{self._provider}: {type(exc).__name__}: {exc}",
                {"source": self._provider, "exc_type": type(exc).__name__},
            ) from exc
        choices = getattr(response, "choices", None)
        if not choices:
            raise QuantError(
                "LLM_FAILED",
                f"{self._provider}: response has no choices",
                {"source": self._provider},
            )
        message = getattr(choices[0], "message", None)
        return self._extract_text(message, getattr(choices[0], "finish_reason", None))

    def _complete_with_moonshot_tool_loop(
        self,
        *,
        system: str,
        user: str,
        max_searches: int,
    ) -> str:
        messages: list[dict[str, object]] = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        tools: list[dict[str, object]] = [
            {"type": "builtin_function", "function": {"name": "$web_search"}}
        ]
        searches_used = 0
        max_turns = max_searches * 2 + 4
        for _ in range(max_turns):
            choice = self._call_chat(messages=messages, tools=tools)
            message = choice.message
            tool_calls = list(getattr(message, "tool_calls", None) or [])
            if not tool_calls:
                return self._extract_text(message, choice.finish_reason)
            messages.append(_serialize_assistant_tool_call(message, tool_calls))
            self._reject_unknown_tools(tool_calls)
            for tc in tool_calls:
                searches_used += 1
                messages.append(_build_search_result_message(tc))
            if searches_used >= max_searches:
                messages.append(_build_search_budget_user_msg())
                tools = []  # disallow further tool use
        raise QuantError(
            "LLM_FAILED",
            f"{self._provider}: web_search loop exceeded {max_turns} turns",
            {"source": self._provider, "max_turns": max_turns},
        )

    def _call_chat(
        self,
        *,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> _ChatChoice:
        try:
            # mypy can't match our dynamic dict-shaped messages / tools to
            # the SDK's TypedDict overloads; the dicts are valid at runtime
            # because the OpenAI client validates them server-side.
            # Kimi's reasoning models (k2.6+) require ``thinking`` be
            # explicitly disabled via ``extra_body`` — otherwise the
            # server demands every echoed assistant tool-call carry
            # ``reasoning_content``, which is not returned in
            # non-streaming responses. They also reject ``temperature=0``
            # and only allow ``0.6`` for this surface.
            # Each web_search round can take 30-90s on a deep query (the
            # platform performs the search server-side); a 240s ceiling
            # gives us headroom over the 60s default used by complete_json.
            response = self._client.with_options(timeout=240.0).chat.completions.create(
                model=self._model,
                temperature=0.6,
                tools=tools,  # type: ignore[arg-type]
                messages=messages,  # type: ignore[arg-type]
                extra_body={"thinking": {"type": "disabled"}},
            )
        except Exception as exc:
            raise QuantError(
                "LLM_FAILED",
                f"{self._provider}: {type(exc).__name__}: {exc}",
                {"source": self._provider, "exc_type": type(exc).__name__},
            ) from exc
        choices = getattr(response, "choices", None)
        if not choices:
            raise QuantError(
                "LLM_FAILED",
                f"{self._provider}: response has no choices",
                {"source": self._provider},
            )
        choice = choices[0]
        message = getattr(choice, "message", None)
        if message is None:
            raise QuantError(
                "LLM_FAILED",
                f"{self._provider}: response missing message",
                {"source": self._provider},
            )
        return _ChatChoice(message=message, finish_reason=getattr(choice, "finish_reason", None))

    def _extract_text(self, message: object, finish_reason: object) -> str:
        content = getattr(message, "content", None)
        if not isinstance(content, str):
            raise QuantError(
                "LLM_FAILED",
                f"{self._provider}: response 'content' is not a string",
                {"source": self._provider, "finish_reason": finish_reason},
            )
        return content

    def _reject_unknown_tools(self, tool_calls: list[object]) -> None:
        unknown = [
            _tool_call_name(tc) for tc in tool_calls if _tool_call_name(tc) != "$web_search"
        ]
        if unknown:
            raise QuantError(
                "LLM_FAILED",
                f"{self._provider}: model invoked unsupported tool",
                {"source": self._provider, "tools": unknown},
            )

    def complete_json(self, *, system: str, user: str) -> str:
        try:
            response = self._client.chat.completions.create(
                model=self._model,
                temperature=0,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            )
        except Exception as exc:
            raise QuantError(
                "LLM_FAILED",
                f"{self._provider}: {type(exc).__name__}: {exc}",
                {"source": self._provider, "exc_type": type(exc).__name__},
            ) from exc
        choices = getattr(response, "choices", None)
        if not choices:
            raise QuantError(
                "LLM_FAILED",
                f"{self._provider}: response has no choices",
                {"source": self._provider},
            )
        message = getattr(choices[0], "message", None)
        content = getattr(message, "content", None) if message is not None else None
        if not isinstance(content, str):
            raise QuantError(
                "LLM_FAILED",
                f"{self._provider}: response 'content' is not a string",
                {"source": self._provider},
            )
        return content


class _ChatChoice:
    """Plain bag for the bits we pluck out of an OpenAI ``Choice``."""

    __slots__ = ("finish_reason", "message")

    def __init__(self, *, message: object, finish_reason: object) -> None:
        self.message = message
        self.finish_reason = finish_reason


def _build_search_result_message(tool_call: object) -> dict[str, object]:
    # Per Moonshot's $web_search spec, echo the arguments back as the
    # tool result. The platform performs the search server-side and
    # folds the result into the next assistant turn.
    return {
        "role": "tool",
        "tool_call_id": getattr(tool_call, "id", None) or "",
        "name": "$web_search",
        "content": _tool_call_arguments(tool_call),
    }


def _build_search_budget_user_msg() -> dict[str, object]:
    return {
        "role": "user",
        "content": (
            "You have reached the web_search budget. "
            "Do not call any more tools. "
            "Produce the final JSON answer now using only "
            "what you have retrieved so far."
        ),
    }


def _tool_call_name(tool_call: object) -> str:
    function = getattr(tool_call, "function", None)
    name = getattr(function, "name", None) if function is not None else None
    return name if isinstance(name, str) else ""


def _tool_call_arguments(tool_call: object) -> str:
    function = getattr(tool_call, "function", None)
    args = getattr(function, "arguments", None) if function is not None else None
    return args if isinstance(args, str) else ""


def _serialize_assistant_tool_call(
    message: object,
    tool_calls: list[object],
) -> dict[str, object]:
    """Re-shape an SDK message back into the dict the API expects on input.

    The OpenAI client returns SDK objects on response, but the chat-create
    request needs plain dicts in ``messages``. We strip to the minimum
    fields the server uses to thread tool-call ↔ tool-result, plus
    ``reasoning_content`` for Kimi k2+ — the server rejects follow-up
    requests when thinking-mode reasoning is dropped on echo.
    """
    serialised_calls: list[dict[str, object]] = []
    for tc in tool_calls:
        serialised_calls.append(
            {
                "id": getattr(tc, "id", None) or "",
                "type": "function",
                "function": {
                    "name": _tool_call_name(tc),
                    "arguments": _tool_call_arguments(tc),
                },
            }
        )
    content = getattr(message, "content", None)
    out: dict[str, object] = {
        "role": "assistant",
        "content": content if isinstance(content, str) else "",
        "tool_calls": serialised_calls,
    }
    reasoning = getattr(message, "reasoning_content", None)
    if isinstance(reasoning, str) and reasoning:
        out["reasoning_content"] = reasoning
    return out
