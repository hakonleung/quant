import os

from openai import OpenAI

client = OpenAI(
    api_key=os.getenv("DASHSCOPE_API_KEY"),
    base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
)
completion = client.chat.completions.create(
    model="qwen-plus",
    messages=[
        {
            "role": "system",
            "content": "你是资深股票分析师，擅长从产业趋势/消息面/预期差等方面分析股票的上涨动因",
        },
        {
            "role": "user",
            "content": "目标股票：华盛昌（002980.SZ）。从并购/热点题材/核心产品/产品价格信号/竞争格局/竞争对手/市场份额/供需/研报目标/情绪评分等角度分析",
        },
    ],
    extra_body={"enable_search": True},
)
print(completion.model_dump_json())
