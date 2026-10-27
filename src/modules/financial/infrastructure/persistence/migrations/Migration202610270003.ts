import { Migration } from '@mikro-orm/migrations';
export class Migration202610270003 extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE financial.sqs_inbox (
        id uuid PRIMARY KEY, consumer_name text NOT NULL, message_id text NOT NULL CHECK (message_id ~ '^[A-Za-z0-9_-]{1,128}$'),
        payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'), hash_version integer NOT NULL CHECK (hash_version=1),
        transaction_id uuid NOT NULL REFERENCES financial.wager_transactions(id),
        body text NOT NULL, source_queue text NOT NULL, transport_message_id text NOT NULL,
        group_id text NOT NULL CHECK (length(group_id) BETWEEN 1 AND 128), dlq_queue text NOT NULL,
        processed_at timestamptz NOT NULL DEFAULT now(),
        disposition text NOT NULL CHECK (disposition IN ('ACK_AFTER_COMMIT','DLQ_REQUIRED')),
        transfer_id uuid, CHECK ((disposition='ACK_AFTER_COMMIT' AND transfer_id IS NULL) OR (disposition='DLQ_REQUIRED' AND transfer_id IS NOT NULL)), UNIQUE(consumer_name,message_id)
      );
      CREATE TABLE financial.sqs_origins (
        transaction_id uuid PRIMARY KEY REFERENCES financial.wager_transactions(id),
        inbox_id uuid NOT NULL UNIQUE REFERENCES financial.sqs_inbox(id), captured_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE financial.dlq_transfers (
        id uuid PRIMARY KEY, origin_inbox_id uuid UNIQUE REFERENCES financial.sqs_inbox(id),
        transaction_id uuid REFERENCES financial.wager_transactions(id), diagnostic_key text UNIQUE,
        consumer_name text NOT NULL, source_queue text NOT NULL, source_transport_message_id text NOT NULL,
        body_hash text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'), body text NOT NULL,
        destination text NOT NULL, group_id text NOT NULL CHECK (length(group_id) BETWEEN 1 AND 128), reason text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
        next_attempt_at timestamptz NOT NULL DEFAULT now(), claim_token uuid, lease_until timestamptz,
        suspended_at timestamptz, dlq_confirmed_at timestamptz,
        CHECK ((origin_inbox_id IS NOT NULL AND transaction_id IS NOT NULL AND diagnostic_key IS NULL)
          OR (origin_inbox_id IS NULL AND transaction_id IS NULL AND diagnostic_key IS NOT NULL))
      );
      ALTER TABLE financial.sqs_inbox ADD FOREIGN KEY(transfer_id) REFERENCES financial.dlq_transfers(id) DEFERRABLE INITIALLY DEFERRED;
      CREATE UNIQUE INDEX one_late_dlq ON financial.dlq_transfers(transaction_id) WHERE reason='PENDING_REFERENCE_FAILED';
      CREATE INDEX ready_dlq ON financial.dlq_transfers(next_attempt_at,created_at) WHERE dlq_confirmed_at IS NULL AND suspended_at IS NULL;
      CREATE TABLE financial.dlq_resume_audit (
        id uuid PRIMARY KEY, transfer_id uuid NOT NULL REFERENCES financial.dlq_transfers(id),
        operator text NOT NULL CHECK(length(operator) BETWEEN 1 AND 128), resumed_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE FUNCTION financial.guard_inbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF ROW(NEW.id,NEW.consumer_name,NEW.message_id,NEW.payload_hash,NEW.hash_version,NEW.transaction_id,NEW.body,
          NEW.source_queue,NEW.transport_message_id,NEW.group_id,NEW.dlq_queue,NEW.processed_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.consumer_name,OLD.message_id,OLD.payload_hash,OLD.hash_version,OLD.transaction_id,OLD.body,
          OLD.source_queue,OLD.transport_message_id,OLD.group_id,OLD.dlq_queue,OLD.processed_at)
          OR (OLD.disposition='DLQ_REQUIRED' AND NEW.disposition<>OLD.disposition)
          OR (OLD.transfer_id IS NOT NULL AND NEW.transfer_id IS DISTINCT FROM OLD.transfer_id) THEN
          RAISE EXCEPTION 'Inbox identity and disposition are immutable' USING ERRCODE='23514';
        END IF; RETURN NEW;
      END $$;
      CREATE FUNCTION financial.guard_dlq() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF ROW(NEW.id,NEW.origin_inbox_id,NEW.transaction_id,NEW.diagnostic_key,NEW.consumer_name,NEW.source_queue,
          NEW.source_transport_message_id,NEW.body_hash,NEW.body,NEW.destination,NEW.group_id,NEW.reason,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.origin_inbox_id,OLD.transaction_id,OLD.diagnostic_key,OLD.consumer_name,OLD.source_queue,
          OLD.source_transport_message_id,OLD.body_hash,OLD.body,OLD.destination,OLD.group_id,OLD.reason,OLD.created_at)
          OR (OLD.dlq_confirmed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
          RAISE EXCEPTION 'DLQ identity and confirmed responsibility are immutable' USING ERRCODE='23514';
        END IF; RETURN NEW;
      END $$;
      CREATE FUNCTION financial.ensure_inbox_dlq(inbox_uuid uuid, failure_reason text) RETURNS uuid
      LANGUAGE plpgsql SET search_path=pg_catalog,financial AS $$
      DECLARE i financial.sqs_inbox%ROWTYPE; transfer_uuid uuid;
      BEGIN
        SELECT * INTO STRICT i FROM financial.sqs_inbox WHERE id=inbox_uuid FOR UPDATE;
        SELECT id INTO transfer_uuid FROM financial.dlq_transfers WHERE origin_inbox_id=i.id;
        IF transfer_uuid IS NULL THEN
          transfer_uuid:=gen_random_uuid();
          INSERT INTO financial.dlq_transfers(id,origin_inbox_id,transaction_id,consumer_name,source_queue,source_transport_message_id,
            body_hash,body,destination,group_id,reason)
          VALUES(transfer_uuid,i.id,i.transaction_id,i.consumer_name,i.source_queue,i.transport_message_id,i.payload_hash,
            i.body,i.dlq_queue,i.group_id,failure_reason);
        END IF;
        UPDATE financial.sqs_inbox SET disposition='DLQ_REQUIRED',transfer_id=transfer_uuid WHERE id=i.id;
        RETURN transfer_uuid;
      END $$;
      CREATE FUNCTION financial.route_pending_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE origin_uuid uuid;
      BEGIN
        IF NEW.status='FAILED' AND OLD.status='PENDING_REFERENCE' THEN
          SELECT inbox_id INTO origin_uuid FROM financial.sqs_origins WHERE transaction_id=NEW.id;
          IF origin_uuid IS NOT NULL THEN PERFORM financial.ensure_inbox_dlq(origin_uuid,'PENDING_REFERENCE_FAILED'); END IF;
        END IF; RETURN NULL;
      END $$;
      CREATE FUNCTION financial.check_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE t financial.wager_transactions%ROWTYPE;
      BEGIN
        SELECT * INTO STRICT t FROM financial.wager_transactions WHERE id=NEW.transaction_id;
        IF EXISTS(SELECT 1 FROM financial.sqs_inbox i LEFT JOIN financial.dlq_transfers d ON d.id=i.transfer_id
          WHERE i.id=NEW.id AND i.disposition='DLQ_REQUIRED' AND (d.id IS NULL OR d.origin_inbox_id IS DISTINCT FROM i.id
            OR d.transaction_id IS DISTINCT FROM i.transaction_id OR d.body IS DISTINCT FROM i.body OR d.destination IS DISTINCT FROM i.dlq_queue)) THEN
          RAISE EXCEPTION 'Inbox transfer differs from its source' USING ERRCODE='23514';
        END IF;
        IF t.status='PENDING' OR (t.status='FAILED' AND NOT EXISTS
          (SELECT 1 FROM financial.sqs_inbox i JOIN financial.dlq_transfers d ON d.id=i.transfer_id WHERE i.id=NEW.id AND i.disposition='DLQ_REQUIRED')) THEN
          RAISE EXCEPTION 'Inbox has no final durable disposition' USING ERRCODE='23514';
        END IF;
        IF t.status='PENDING_REFERENCE' AND NOT EXISTS(SELECT 1 FROM financial.sqs_origins WHERE transaction_id=t.id) THEN
          RAISE EXCEPTION 'Pending SQS transaction requires a recoverable origin' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
      END $$;
      CREATE FUNCTION financial.guard_sqs_origin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM financial.sqs_inbox WHERE id=NEW.inbox_id AND transaction_id=NEW.transaction_id) THEN
          RAISE EXCEPTION 'Canonical origin differs from transaction' USING ERRCODE='23514';
        END IF; RETURN NEW;
      END $$;
      CREATE TRIGGER origin_context BEFORE INSERT ON financial.sqs_origins FOR EACH ROW EXECUTE FUNCTION financial.guard_sqs_origin();
      CREATE TRIGGER inbox_immutable BEFORE UPDATE ON financial.sqs_inbox FOR EACH ROW EXECUTE FUNCTION financial.guard_inbox();
      CREATE TRIGGER dlq_immutable BEFORE UPDATE ON financial.dlq_transfers FOR EACH ROW EXECUTE FUNCTION financial.guard_dlq();
      CREATE TRIGGER route_pending_failure AFTER UPDATE ON financial.wager_transactions FOR EACH ROW EXECUTE FUNCTION financial.route_pending_failure();
      CREATE CONSTRAINT TRIGGER inbox_complete AFTER INSERT OR UPDATE ON financial.sqs_inbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION financial.check_inbox();
      CREATE TRIGGER origin_immutable BEFORE UPDATE OR DELETE ON financial.sqs_origins FOR EACH ROW EXECUTE FUNCTION financial.reject_history_change();
      CREATE TRIGGER inbox_preserved BEFORE DELETE ON financial.sqs_inbox FOR EACH ROW EXECUTE FUNCTION financial.reject_history_change();
      CREATE TRIGGER dlq_preserved BEFORE DELETE ON financial.dlq_transfers FOR EACH ROW EXECUTE FUNCTION financial.reject_history_change();
      CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON financial.dlq_resume_audit FOR EACH ROW EXECUTE FUNCTION financial.reject_history_change();
      GRANT SELECT,INSERT ON financial.sqs_inbox,financial.sqs_origins,financial.dlq_transfers,financial.dlq_resume_audit TO wager_app;
      GRANT UPDATE(disposition,transfer_id) ON financial.sqs_inbox TO wager_app;
      GRANT UPDATE(attempts,next_attempt_at,claim_token,lease_until,suspended_at,dlq_confirmed_at) ON financial.dlq_transfers TO wager_app;
    `);
  }
  override down(): void {
    this.addSql(`
      DROP TRIGGER route_pending_failure ON financial.wager_transactions;
      DROP FUNCTION financial.route_pending_failure();
      DROP TABLE financial.dlq_resume_audit;
      ALTER TABLE financial.sqs_inbox DROP CONSTRAINT sqs_inbox_transfer_id_fkey;
      DROP TABLE financial.dlq_transfers;
      DROP TABLE financial.sqs_origins;
      DROP TABLE financial.sqs_inbox;
      DROP FUNCTION financial.check_inbox(); DROP FUNCTION financial.ensure_inbox_dlq(uuid,text);
      DROP FUNCTION financial.guard_sqs_origin(); DROP FUNCTION financial.guard_dlq(); DROP FUNCTION financial.guard_inbox();
    `);
  }
}
