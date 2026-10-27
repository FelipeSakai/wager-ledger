import { Migration } from '@mikro-orm/migrations';

export class Migration202610270002 extends Migration {
  override up(): void {
    this.addSql(`
      ALTER TABLE financial.wager_transactions
        ADD COLUMN payload_hash_version integer,
        ADD COLUMN reference_attempts integer NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        ADD COLUMN next_reference_attempt_at timestamptz CHECK (isfinite(next_reference_attempt_at)),
        ADD COLUMN reference_expires_at timestamptz CHECK (isfinite(reference_expires_at)),
        ADD COLUMN pending_reason text CHECK (pending_reason IN ('REFERENCE_NOT_FOUND', 'REFERENCE_NOT_READY'));
      SET CONSTRAINTS ALL IMMEDIATE;
      ALTER TABLE financial.wager_transactions DISABLE TRIGGER guard_transaction;
      UPDATE financial.wager_transactions SET payload_hash_version = 1 WHERE origin = 'PROVIDER';
      ALTER TABLE financial.wager_transactions ENABLE TRIGGER guard_transaction;
      ALTER TABLE financial.wager_transactions ADD CONSTRAINT payload_hash_algorithm
        CHECK ((origin = 'PROVIDER' AND payload_hash_version IS NOT NULL AND payload_hash_version = 1)
          OR (origin = 'INTERNAL' AND payload_hash_version IS NULL));
      ALTER TABLE financial.wager_transactions ADD CONSTRAINT durable_reference_schedule
        CHECK (status <> 'PENDING_REFERENCE' OR (next_reference_attempt_at IS NOT NULL
          AND reference_expires_at IS NOT NULL AND pending_reason IS NOT NULL AND reference_attempts > 0));
      CREATE INDEX pending_reference_schedule ON financial.wager_transactions(next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
      GRANT UPDATE (reference_attempts, next_reference_attempt_at, reference_expires_at, pending_reason)
        ON financial.wager_transactions TO wager_app;
      CREATE FUNCTION financial.guard_reference_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'UPDATE' AND (
          NEW.payload_hash_version IS DISTINCT FROM OLD.payload_hash_version
          OR (OLD.reference_expires_at IS NOT NULL AND NEW.reference_expires_at IS DISTINCT FROM OLD.reference_expires_at)
          OR NEW.reference_attempts < OLD.reference_attempts
          OR NEW.reference_attempts > OLD.reference_attempts + 1) THEN
          RAISE EXCEPTION 'Reference schedule or hash algorithm is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER guard_reference_schedule BEFORE INSERT OR UPDATE ON financial.wager_transactions
        FOR EACH ROW EXECUTE FUNCTION financial.guard_reference_schedule();
      SET CONSTRAINTS ALL DEFERRED;
    `);
  }
  override down(): void {
    this.addSql(`
      DROP TRIGGER guard_reference_schedule ON financial.wager_transactions;
      DROP FUNCTION financial.guard_reference_schedule();
      DROP INDEX financial.pending_reference_schedule;
      ALTER TABLE financial.wager_transactions DROP CONSTRAINT durable_reference_schedule,
        DROP CONSTRAINT payload_hash_algorithm,
        DROP COLUMN payload_hash_version, DROP COLUMN reference_attempts,
        DROP COLUMN next_reference_attempt_at, DROP COLUMN reference_expires_at, DROP COLUMN pending_reason;
    `);
  }
}
