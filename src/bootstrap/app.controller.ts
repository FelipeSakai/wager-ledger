import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@Controller()
@ApiTags('Operação')
export class AppController {
  @Get()
  @ApiOperation({
    operationId: 'applicationInfo',
    summary: 'Identificar a aplicação',
    description: 'Informação estática. Use health/ready para verificar prontidão.',
  })
  @ApiResponse({
    status: 200,
    description: 'Identificação da aplicação.',
    schema: {
      type: 'object',
      required: ['name', 'status'],
      properties: {
        name: { type: 'string', enum: ['wager-ledger'] },
        status: { type: 'string', enum: ['bootstrap'] },
      },
    },
  })
  info(): { name: string; status: string } {
    return { name: 'wager-ledger', status: 'bootstrap' };
  }
}
