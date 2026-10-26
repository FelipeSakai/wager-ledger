import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  info(): { name: string; status: string } {
    return { name: 'wager-ledger', status: 'bootstrap' };
  }
}
