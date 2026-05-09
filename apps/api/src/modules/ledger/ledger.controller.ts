/**
 * HTTP routes for the personal ledger.
 *
 *   GET    /api/ledger                  → entries (raw, persisted shape)
 *   GET    /api/ledger/enriched         → entries with derived chain fields
 *   POST   /api/ledger                  → create one entry
 *   PATCH  /api/ledger/:date            → patch one entry
 *   DELETE /api/ledger/:date            → delete one entry
 *   POST   /api/ledger/import           → merge-import
 *   GET    /api/ledger/export           → JSON download
 *   GET    /api/ledger/analyze          → cached analysis (404 on miss)
 *   POST   /api/ledger/analyze          → fresh analysis (LLM, paid)
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type {
  EnrichedLedgerEntry,
  LedgerAnalysis,
  LedgerEntry,
  LedgerSnapshot,
} from '@quant/shared';
import type { Request, Response } from 'express';

import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/request-with-user.js';
import {
  LedgerAnalyzeBodySchema,
  LedgerCreateBodySchema,
  LedgerDateParamSchema,
  LedgerImportBodySchema,
  LedgerPatchBodySchema,
  type LedgerAnalyzeBody,
  type LedgerCreateBody,
  type LedgerDateParam,
  type LedgerImportBody,
  type LedgerPatchBody,
} from './dto/ledger.dto.js';
import { LedgerService } from './ledger.service.js';

const createPipe = new ZodValidationPipe(LedgerCreateBodySchema);
const patchPipe = new ZodValidationPipe(LedgerPatchBodySchema);
const paramPipe = new ZodValidationPipe(LedgerDateParamSchema);
const importPipe = new ZodValidationPipe(LedgerImportBodySchema);
const analyzePipe = new ZodValidationPipe(LedgerAnalyzeBodySchema);

@Controller('ledger')
export class LedgerController {
  constructor(@Inject(LedgerService) private readonly service: LedgerService) {}

  // --- Static paths must come before `:date` so Express dispatches them
  //     correctly. Order matters here. ---

  @Get('enriched')
  enriched(@CurrentUser() user: AuthenticatedUser): Promise<readonly EnrichedLedgerEntry[]> {
    return this.service.enriched(user.id);
  }

  @Post('import')
  async importEntries(
    @CurrentUser() user: AuthenticatedUser,
    @Body(importPipe) body: LedgerImportBody,
  ): Promise<LedgerSnapshot> {
    return this.service.importEntries(user.id, body.entries);
  }

  @Get('export')
  async exportEntries(@CurrentUser() user: AuthenticatedUser, @Res() res: Response): Promise<void> {
    const entries = await this.service.list(user.id);
    const snap: LedgerSnapshot = { entries: entries as LedgerEntry[] };
    const today = new Date();
    const stamp = `${String(today.getFullYear())}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="ledger-${stamp}.json"`);
    res.status(200).send(JSON.stringify(snap, null, 2));
  }

  @Get('analyze')
  async getCachedAnalysis(@CurrentUser() user: AuthenticatedUser): Promise<LedgerAnalysis> {
    const hit = await this.service.cachedAnalysis(user.id);
    if (hit === null) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'no cached ledger analysis',
        details: {},
      });
    }
    return hit;
  }

  @Post('analyze')
  async analyze(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Body(analyzePipe) body: LedgerAnalyzeBody,
  ): Promise<LedgerAnalysis> {
    const traceId = (req as Request & { traceId?: string }).traceId ?? '';
    return this.service.analyze(user.id, traceId, body.bypassCache ?? false);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<readonly LedgerEntry[]> {
    return this.service.list(user.id);
  }

  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(createPipe) body: LedgerCreateBody,
  ): Promise<LedgerEntry> {
    return this.service.create(user.id, body);
  }

  @Patch(':date')
  async patch(
    @CurrentUser() user: AuthenticatedUser,
    @Param(paramPipe) params: LedgerDateParam,
    @Body(patchPipe) body: LedgerPatchBody,
  ): Promise<LedgerEntry> {
    return this.service.patch(user.id, params.date, body);
  }

  @Delete(':date')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param(paramPipe) params: LedgerDateParam,
  ): Promise<void> {
    await this.service.remove(user.id, params.date);
  }
}
