import { Migration } from '@mikro-orm/migrations';
import { financialSchema } from './financial-schema';

export class Migration202610270001 extends Migration {
  override up(): void {
    this.addSql(financialSchema);
  }

  override down(): void {
    this.addSql('drop schema financial cascade;');
  }
}
