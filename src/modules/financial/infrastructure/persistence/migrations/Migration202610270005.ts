import { Migration } from '@mikro-orm/migrations';
export class Migration202610270005 extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE financial.failure_diagnostics (
        transaction_id uuid PRIMARY KEY REFERENCES financial.wager_transactions(id),
        failure_code text NOT NULL, correlation_id uuid NOT NULL,
        failed_at timestamptz NOT NULL CHECK(isfinite(failed_at))
      );
      CREATE FUNCTION financial.check_failure_diagnostic() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM financial.wager_transactions t WHERE t.id=NEW.transaction_id
          AND t.status='FAILED' AND t.failure_code=NEW.failure_code AND t.completed_at=NEW.failed_at) THEN
          RAISE EXCEPTION 'Failure diagnostic must match terminal transaction' USING ERRCODE='23514';
        END IF; RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER failure_diagnostic_matches AFTER INSERT ON financial.failure_diagnostics
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION financial.check_failure_diagnostic();
      CREATE TRIGGER failure_diagnostic_immutable BEFORE UPDATE OR DELETE ON financial.failure_diagnostics
        FOR EACH ROW EXECUTE FUNCTION financial.reject_history_change();
      GRANT SELECT,INSERT ON financial.failure_diagnostics TO wager_app;
      CREATE OR REPLACE FUNCTION financial.route_pending_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE origin_uuid uuid;
      BEGIN
        IF NEW.status='FAILED' AND OLD.status='PENDING_REFERENCE' THEN
          INSERT INTO financial.failure_diagnostics(transaction_id,failure_code,correlation_id,failed_at)
            VALUES(NEW.id,NEW.failure_code,COALESCE(NULLIF(current_setting('wager.failure_correlation_id',true),''),gen_random_uuid()::text)::uuid,NEW.completed_at);
          SELECT inbox_id INTO origin_uuid FROM financial.sqs_origins WHERE transaction_id=NEW.id;
          IF origin_uuid IS NOT NULL THEN PERFORM financial.ensure_inbox_dlq(origin_uuid,'PENDING_REFERENCE_FAILED'); END IF;
        END IF; RETURN NULL;
      END $$;
    `);
  }
  override down(): void {
    this.addSql(`
      CREATE OR REPLACE FUNCTION financial.route_pending_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE origin_uuid uuid;
      BEGIN
        IF NEW.status='FAILED' AND OLD.status='PENDING_REFERENCE' THEN
          SELECT inbox_id INTO origin_uuid FROM financial.sqs_origins WHERE transaction_id=NEW.id;
          IF origin_uuid IS NOT NULL THEN PERFORM financial.ensure_inbox_dlq(origin_uuid,'PENDING_REFERENCE_FAILED'); END IF;
        END IF; RETURN NULL;
      END $$;
      DROP TABLE financial.failure_diagnostics;
      DROP FUNCTION financial.check_failure_diagnostic();
    `);
  }
}
