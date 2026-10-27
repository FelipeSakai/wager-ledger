import { Migration } from '@mikro-orm/migrations';

export class Migration202610270004 extends Migration {
  override up(): void {
    this.addSql(`
      ALTER TABLE financial.outbox_messages ADD COLUMN last_error_code text
        CHECK(last_error_code IN ('SQS_SEND_FAILED','INVALID_EVENT_ENVELOPE'));
      ALTER TABLE financial.outbox_messages ADD CONSTRAINT outbox_claim_pair
        CHECK((claim_token IS NULL)=(lease_until IS NULL));
      ALTER TABLE financial.outbox_messages ADD CONSTRAINT outbox_finite_delivery_dates
        CHECK((next_attempt_at IS NULL OR isfinite(next_attempt_at)) AND (published_at IS NULL OR isfinite(published_at))
          AND (lease_until IS NULL OR isfinite(lease_until)) AND (suspended_at IS NULL OR isfinite(suspended_at)));
      CREATE TABLE financial.outbox_resume_audit (
        id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES financial.outbox_messages(id),
        operator text NOT NULL CHECK(length(operator) BETWEEN 1 AND 128), resumed_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE FUNCTION financial.guard_published_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP='INSERT' THEN
          IF NEW.published_at IS NOT NULL OR NEW.claim_token IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.suspended_at IS NOT NULL OR NEW.attempts<>0 THEN
            RAISE EXCEPTION 'New outbox events must be unpublished and unclaimed' USING ERRCODE='23514';
          END IF;
          RETURN NEW;
        END IF;
        IF OLD.published_at IS NULL AND NEW.published_at IS NOT NULL AND
          (OLD.claim_token IS NULL OR OLD.lease_until<=clock_timestamp() OR NEW.claim_token IS NOT NULL OR NEW.lease_until IS NOT NULL) THEN
          RAISE EXCEPTION 'Publication confirmation requires a live claim' USING ERRCODE='23514';
        END IF;
        IF OLD.published_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
          RAISE EXCEPTION 'Published outbox cannot be reopened or rewritten' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER published_outbox_immutable BEFORE INSERT OR UPDATE ON financial.outbox_messages
        FOR EACH ROW EXECUTE FUNCTION financial.guard_published_outbox();
      CREATE TRIGGER outbox_resume_audit_immutable BEFORE UPDATE OR DELETE ON financial.outbox_resume_audit
        FOR EACH ROW EXECUTE FUNCTION financial.reject_history_change();
      GRANT SELECT,INSERT ON financial.outbox_resume_audit TO wager_app;
      GRANT UPDATE(last_error_code) ON financial.outbox_messages TO wager_app;
    `);
  }
  override down(): void {
    this.addSql(`
      DROP TRIGGER published_outbox_immutable ON financial.outbox_messages;
      DROP FUNCTION financial.guard_published_outbox();
      DROP TABLE financial.outbox_resume_audit;
      ALTER TABLE financial.outbox_messages DROP CONSTRAINT outbox_claim_pair,
        DROP CONSTRAINT outbox_finite_delivery_dates,DROP COLUMN last_error_code;
    `);
  }
}
