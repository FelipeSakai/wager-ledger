export const financialSchema = `
CREATE SCHEMA financial;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA financial FROM PUBLIC;
GRANT USAGE ON SCHEMA financial TO wager_app;

CREATE FUNCTION financial.valid_money(value numeric) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT value BETWEEN 0::numeric AND 999999999999999999.99::numeric
$$;

CREATE TABLE financial.wallets (
  id uuid PRIMARY KEY,
  player_id uuid NOT NULL,
  currency text NOT NULL CHECK (currency IN ('BRL', 'USD')),
  balance numeric(20, 2) NOT NULL CHECK (financial.valid_money(balance)),
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  updated_at timestamptz NOT NULL CHECK (isfinite(updated_at)),
  UNIQUE (player_id, currency),
  UNIQUE (id, currency)
);

CREATE TABLE financial.wager_transactions (
  id uuid PRIMARY KEY,
  wallet_id uuid NOT NULL REFERENCES financial.wallets(id) DEFERRABLE INITIALLY DEFERRED,
  player_id uuid NOT NULL,
  currency text NOT NULL CHECK (currency IN ('BRL', 'USD')),
  amount numeric(20, 2) NOT NULL CHECK (financial.valid_money(amount)),
  origin text NOT NULL CHECK (origin IN ('INTERNAL', 'PROVIDER')),
  kind text NOT NULL CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
  status text NOT NULL CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
  internal_identity text UNIQUE,
  provider_id text,
  external_transaction_id text,
  idempotency_key text UNIQUE,
  payload_hash text,
  round_id text,
  game_id text,
  reference_external_transaction_id text,
  reference_transaction_id uuid REFERENCES financial.wager_transactions(id) DEFERRABLE INITIALLY DEFERRED,
  failure_code text,
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  processed_at timestamptz CHECK (isfinite(processed_at)),
  completed_at timestamptz CHECK (isfinite(completed_at)),
  UNIQUE (provider_id, external_transaction_id),
  UNIQUE (id, wallet_id, currency),
  CHECK (
    (origin = 'INTERNAL' AND kind = 'OPENING' AND amount > 0
      AND internal_identity IS NOT NULL AND internal_identity = 'opening:' || wallet_id::text
      AND provider_id IS NULL AND external_transaction_id IS NULL AND idempotency_key IS NULL
      AND payload_hash IS NULL AND round_id IS NULL AND game_id IS NULL
      AND reference_external_transaction_id IS NULL AND reference_transaction_id IS NULL)
    OR
    (origin = 'PROVIDER' AND kind <> 'OPENING' AND internal_identity IS NULL
      AND provider_id IS NOT NULL AND length(provider_id) > 0
      AND external_transaction_id IS NOT NULL AND length(external_transaction_id) > 0
      AND idempotency_key IS NOT NULL AND length(idempotency_key) > 0
      AND payload_hash IS NOT NULL AND payload_hash ~ '^[0-9a-f]{64}$'
      AND round_id IS NOT NULL AND length(round_id) > 0
      AND game_id IS NOT NULL AND length(game_id) > 0)
  ),
  CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR
    (reference_external_transaction_id IS NOT NULL AND length(reference_external_transaction_id) > 0)),
  CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
  CHECK ((status IN ('PROCESSED', 'REJECTED', 'FAILED')) = (completed_at IS NOT NULL)),
  CHECK (status NOT IN ('PROCESSED', 'REJECTED', 'FAILED') OR result IS NOT NULL),
  CHECK ((status IN ('REJECTED', 'FAILED') AND failure_code IS NOT NULL AND length(failure_code) > 0)
    OR (status NOT IN ('REJECTED', 'FAILED') AND failure_code IS NULL))
);
CREATE UNIQUE INDEX one_opening_per_wallet ON financial.wager_transactions(wallet_id) WHERE kind = 'OPENING';
CREATE UNIQUE INDEX one_effective_reversal ON financial.wager_transactions(reference_transaction_id)
  WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED';

CREATE TABLE financial.wallet_ledger_entries (
  id uuid PRIMARY KEY,
  wallet_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  wallet_version bigint NOT NULL CHECK (wallet_version BETWEEN 1 AND 9007199254740991),
  direction text NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  currency text NOT NULL CHECK (currency IN ('BRL', 'USD')),
  amount numeric(20, 2) NOT NULL CHECK (financial.valid_money(amount) AND amount > 0),
  balance_before numeric(20, 2) NOT NULL CHECK (financial.valid_money(balance_before)),
  balance_after numeric(20, 2) NOT NULL CHECK (financial.valid_money(balance_after)),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  UNIQUE (wallet_id, transaction_id),
  UNIQUE (wallet_id, wallet_version),
  FOREIGN KEY (wallet_id, currency) REFERENCES financial.wallets(id, currency) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (transaction_id, wallet_id, currency)
    REFERENCES financial.wager_transactions(id, wallet_id, currency) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((direction = 'CREDIT' AND balance_before + amount = balance_after)
    OR (direction = 'DEBIT' AND balance_before - amount = balance_after)),
  CHECK (wallet_version <> 1 OR (direction = 'CREDIT' AND balance_before = 0))
);

CREATE TABLE financial.outbox_messages (
  id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES financial.wager_transactions(id) DEFERRABLE INITIALLY DEFERRED,
  aggregate_id uuid NOT NULL REFERENCES financial.wallets(id) DEFERRABLE INITIALLY DEFERRED,
  event_type text NOT NULL CHECK (event_type IN (
    'WagerTransactionProcessed', 'WagerTransactionRejected', 'WalletBalanceChanged', 'WagerTransactionPendingReference')),
  event_version integer NOT NULL CHECK (event_version = 1),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at)),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  published_at timestamptz,
  claim_token uuid,
  lease_until timestamptz,
  suspended_at timestamptz,
  UNIQUE (transaction_id, event_type)
);
CREATE INDEX pending_outbox ON financial.outbox_messages(next_attempt_at, occurred_at) WHERE published_at IS NULL;

CREATE FUNCTION financial.reject_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Financial history cannot be deleted, rewritten or truncated' USING ERRCODE = '42501';
END $$;

CREATE FUNCTION financial.guard_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.created_at IS DISTINCT FROM NEW.updated_at THEN
      RAISE EXCEPTION 'Invalid wallet creation state' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
      RAISE EXCEPTION 'Wallet identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF (NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1)
      OR (NEW.balance = OLD.balance AND
        (NEW.version <> OLD.version OR NEW.updated_at IS DISTINCT FROM OLD.updated_at)) THEN
      RAISE EXCEPTION 'Wallet movement must advance one financial version' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION financial.guard_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Terminal transaction is immutable' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW.id, NEW.wallet_id, NEW.player_id, NEW.currency, NEW.amount, NEW.origin, NEW.kind,
        NEW.internal_identity, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key,
        NEW.payload_hash, NEW.round_id, NEW.game_id, NEW.reference_external_transaction_id, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.wallet_id, OLD.player_id, OLD.currency, OLD.amount, OLD.origin, OLD.kind,
        OLD.internal_identity, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key,
        OLD.payload_hash, OLD.round_id, OLD.game_id, OLD.reference_external_transaction_id, OLD.created_at) THEN
      RAISE EXCEPTION 'Transaction identity and command are immutable' USING ERRCODE = '23514';
    END IF;
    IF (OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING')
      OR (OLD.reference_transaction_id IS NOT NULL AND NEW.reference_transaction_id IS DISTINCT FROM OLD.reference_transaction_id) THEN
      RAISE EXCEPTION 'Invalid transaction transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  PERFORM 1 FROM financial.wallets WHERE id = NEW.wallet_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet not found' USING ERRCODE = '23503'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION financial.lock_ledger_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM financial.wallets WHERE id = NEW.wallet_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet not found' USING ERRCODE = '23503'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION financial.guard_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.transaction_id, NEW.aggregate_id, NEW.event_type, NEW.event_version, NEW.payload, NEW.occurred_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.transaction_id, OLD.aggregate_id, OLD.event_type, OLD.event_version, OLD.payload, OLD.occurred_at) THEN
    RAISE EXCEPTION 'Outbox fact is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION financial.assert_transaction(transaction_uuid uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, financial AS $$
DECLARE
  t financial.wager_transactions%ROWTYPE;
  w financial.wallets%ROWTYPE;
  l financial.wallet_ledger_entries%ROWTYPE;
  r financial.wager_transactions%ROWTYPE;
  reference_direction text;
  expected_direction text;
BEGIN
  SELECT * INTO t FROM financial.wager_transactions WHERE id = transaction_uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction is missing' USING ERRCODE = '23503'; END IF;
  SELECT * INTO STRICT w FROM financial.wallets WHERE id = t.wallet_id;
  SELECT * INTO l FROM financial.wallet_ledger_entries WHERE transaction_id = t.id AND wallet_id = t.wallet_id;
  IF t.status = 'PENDING' THEN
    RAISE EXCEPTION 'An unprocessed reservation cannot be committed' USING ERRCODE = '23514';
  END IF;
  IF t.status = 'PROCESSED' THEN
    IF t.player_id <> w.player_id OR t.currency <> w.currency THEN
      RAISE EXCEPTION 'Processed transaction context differs from its wallet' USING ERRCODE = '23514';
    END IF;
    IF t.reference_transaction_id IS NOT NULL THEN
      SELECT * INTO r FROM financial.wager_transactions WHERE id = t.reference_transaction_id;
      IF NOT FOUND OR r.id = t.id OR r.status <> 'PROCESSED'
        OR ROW(r.provider_id, r.player_id, r.wallet_id, r.currency, r.round_id)
          IS DISTINCT FROM ROW(t.provider_id, t.player_id, t.wallet_id, t.currency, t.round_id)
        OR r.external_transaction_id IS DISTINCT FROM t.reference_external_transaction_id THEN
        RAISE EXCEPTION 'Invalid processed reference context' USING ERRCODE = '23514';
      END IF;
      IF (t.kind IN ('WIN', 'LOSS', 'REFUND') AND r.kind <> 'BET')
        OR (t.kind = 'ROLLBACK' AND r.kind NOT IN ('BET', 'WIN', 'REFUND'))
        OR (t.kind IN ('REFUND', 'ROLLBACK') AND t.amount <> r.amount) THEN
        RAISE EXCEPTION 'Invalid reference kind or reversal amount' USING ERRCODE = '23514';
      END IF;
    ELSIF t.kind IN ('REFUND', 'ROLLBACK') OR t.reference_external_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'Processed reference must be resolved' USING ERRCODE = '23514';
    END IF;
    IF t.kind = 'LOSS' THEN
      IF t.amount <> 0 OR l.id IS NOT NULL THEN
        RAISE EXCEPTION 'LOSS cannot move money' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF t.amount <= 0 OR l.id IS NULL OR l.amount <> t.amount OR l.currency <> t.currency THEN
        RAISE EXCEPTION 'Processed movement requires one matching ledger entry' USING ERRCODE = '23514';
      END IF;
      expected_direction := CASE WHEN t.kind = 'BET' THEN 'DEBIT' ELSE 'CREDIT' END;
      IF t.kind = 'ROLLBACK' THEN
        SELECT direction INTO reference_direction FROM financial.wallet_ledger_entries WHERE transaction_id = r.id;
        expected_direction := CASE WHEN reference_direction = 'CREDIT' THEN 'DEBIT' ELSE 'CREDIT' END;
      END IF;
      IF l.direction <> expected_direction OR
        (t.kind = 'OPENING' AND (l.wallet_version <> 1 OR l.balance_before <> 0)) OR
        (t.kind <> 'OPENING' AND l.wallet_version = 1) THEN
        RAISE EXCEPTION 'Ledger direction or opening version is invalid' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM financial.outbox_messages WHERE transaction_id = t.id AND event_type = 'WalletBalanceChanged') THEN
        RAISE EXCEPTION 'Balance change event is missing' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM financial.outbox_messages WHERE transaction_id = t.id AND event_type = 'WagerTransactionProcessed') THEN
      RAISE EXCEPTION 'Processed event is missing' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF l.id IS NOT NULL THEN RAISE EXCEPTION 'Unapplied transaction cannot have a ledger' USING ERRCODE = '23514'; END IF;
    IF t.status = 'REJECTED' AND NOT EXISTS
      (SELECT 1 FROM financial.outbox_messages WHERE transaction_id = t.id AND event_type = 'WagerTransactionRejected') THEN
      RAISE EXCEPTION 'Rejected event is missing' USING ERRCODE = '23514';
    END IF;
    IF t.status = 'PENDING_REFERENCE' AND NOT EXISTS
      (SELECT 1 FROM financial.outbox_messages WHERE transaction_id = t.id AND event_type = 'WagerTransactionPendingReference') THEN
      RAISE EXCEPTION 'Pending reference event is missing' USING ERRCODE = '23514';
    END IF;
  END IF;
END $$;

CREATE FUNCTION financial.check_wallet_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, financial AS $$
DECLARE l financial.wallet_ledger_entries%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO l FROM financial.wallet_ledger_entries WHERE wallet_id = NEW.id AND wallet_version = 1;
    IF NEW.balance = 0 THEN
      IF l.id IS NOT NULL OR EXISTS (SELECT 1 FROM financial.wager_transactions WHERE wallet_id = NEW.id AND kind = 'OPENING') THEN
        RAISE EXCEPTION 'Zero opening cannot create financial history' USING ERRCODE = '23514';
      END IF;
    ELSIF l.id IS NULL OR l.direction <> 'CREDIT' OR l.balance_before <> 0 OR l.balance_after <> NEW.balance
      OR l.created_at IS DISTINCT FROM NEW.created_at OR NOT EXISTS
        (SELECT 1 FROM financial.wager_transactions WHERE id = l.transaction_id AND kind = 'OPENING' AND status = 'PROCESSED') THEN
      RAISE EXCEPTION 'Positive opening requires its original ledger and transaction' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.balance <> OLD.balance THEN
    SELECT * INTO l FROM financial.wallet_ledger_entries WHERE wallet_id = NEW.id AND wallet_version = NEW.version;
    IF l.id IS NULL OR l.balance_before <> OLD.balance OR l.balance_after <> NEW.balance
      OR l.created_at IS DISTINCT FROM NEW.updated_at THEN
      RAISE EXCEPTION 'Wallet transition is missing its exact ledger entry' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION financial.check_ledger_chain() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, financial AS $$
DECLARE
  w financial.wallets%ROWTYPE;
  previous_entry financial.wallet_ledger_entries%ROWTYPE;
  next_entry financial.wallet_ledger_entries%ROWTYPE;
BEGIN
  SELECT * INTO STRICT w FROM financial.wallets WHERE id = NEW.wallet_id;
  IF NEW.wallet_version > w.version THEN RAISE EXCEPTION 'Ledger is ahead of wallet' USING ERRCODE = '23514'; END IF;
  IF NEW.wallet_version > 1 THEN
    SELECT * INTO previous_entry FROM financial.wallet_ledger_entries
      WHERE wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version - 1;
    IF previous_entry.id IS NULL THEN
      IF NEW.wallet_version <> 2 OR NEW.balance_before <> 0
        OR EXISTS (SELECT 1 FROM financial.wager_transactions WHERE wallet_id = NEW.wallet_id AND kind = 'OPENING') THEN
        RAISE EXCEPTION 'Ledger predecessor is missing' USING ERRCODE = '23514';
      END IF;
    ELSIF previous_entry.balance_after <> NEW.balance_before THEN
      RAISE EXCEPTION 'Ledger predecessor balance differs' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.wallet_version < w.version THEN
    SELECT * INTO next_entry FROM financial.wallet_ledger_entries
      WHERE wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version + 1;
    IF next_entry.id IS NULL OR next_entry.balance_before <> NEW.balance_after THEN
      RAISE EXCEPTION 'Ledger successor is missing or inconsistent' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.balance_after <> w.balance THEN
    RAISE EXCEPTION 'Wallet balance differs from ledger head' USING ERRCODE = '23514';
  END IF;
  PERFORM financial.assert_transaction(NEW.transaction_id);
  RETURN NULL;
END $$;

CREATE FUNCTION financial.check_transaction() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, financial AS $$
BEGIN
  PERFORM financial.assert_transaction(NEW.id);
  RETURN NULL;
END $$;

CREATE FUNCTION financial.check_outbox_fact() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, financial AS $$
DECLARE t financial.wager_transactions%ROWTYPE; l financial.wallet_ledger_entries%ROWTYPE; data jsonb;
BEGIN
  SELECT * INTO STRICT t FROM financial.wager_transactions WHERE id = NEW.transaction_id;
  data := NEW.payload -> 'data';
  IF NEW.aggregate_id <> t.wallet_id OR NEW.payload ->> 'eventId' IS DISTINCT FROM NEW.id::text
    OR NEW.payload ->> 'eventType' IS DISTINCT FROM NEW.event_type
    OR NEW.payload ->> 'aggregateId' IS DISTINCT FROM NEW.aggregate_id::text
    OR NEW.payload -> 'version' IS DISTINCT FROM to_jsonb(NEW.event_version)
    OR data ->> 'walletId' IS DISTINCT FROM t.wallet_id::text
    OR data ->> 'transactionId' IS DISTINCT FROM t.id::text THEN
    RAISE EXCEPTION 'Outbox envelope differs from its financial identity' USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type = 'WalletBalanceChanged' THEN
    SELECT * INTO l FROM financial.wallet_ledger_entries WHERE transaction_id = t.id;
    IF l.id IS NULL OR t.status <> 'PROCESSED'
      OR data -> 'money' IS DISTINCT FROM jsonb_build_object('amount', l.amount::text, 'currency', l.currency)
      OR data -> 'balanceBefore' IS DISTINCT FROM jsonb_build_object('amount', l.balance_before::text, 'currency', l.currency)
      OR data -> 'balanceAfter' IS DISTINCT FROM jsonb_build_object('amount', l.balance_after::text, 'currency', l.currency)
      OR data -> 'walletVersion' IS DISTINCT FROM to_jsonb(l.wallet_version)
      OR data ->> 'direction' IS DISTINCT FROM l.direction THEN
      RAISE EXCEPTION 'Balance event differs from its ledger entry' USING ERRCODE = '23514';
    END IF;
  ELSIF (NEW.event_type = 'WagerTransactionProcessed' AND t.status <> 'PROCESSED')
    OR (NEW.event_type = 'WagerTransactionRejected' AND t.status <> 'REJECTED') THEN
    RAISE EXCEPTION 'Outbox event differs from terminal result' USING ERRCODE = '23514';
  END IF;
  PERFORM financial.assert_transaction(t.id);
  RETURN NULL;
END $$;

CREATE TRIGGER guard_wallet BEFORE INSERT OR UPDATE ON financial.wallets FOR EACH ROW EXECUTE FUNCTION financial.guard_wallet();
CREATE TRIGGER guard_transaction BEFORE INSERT OR UPDATE ON financial.wager_transactions FOR EACH ROW EXECUTE FUNCTION financial.guard_transaction();
CREATE TRIGGER lock_ledger_wallet BEFORE INSERT ON financial.wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION financial.lock_ledger_wallet();
CREATE TRIGGER guard_outbox BEFORE UPDATE ON financial.outbox_messages FOR EACH ROW EXECUTE FUNCTION financial.guard_outbox();
CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE ON financial.wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION financial.reject_history_change();
CREATE TRIGGER preserve_wallet BEFORE DELETE ON financial.wallets FOR EACH ROW EXECUTE FUNCTION financial.reject_history_change();
CREATE TRIGGER preserve_transaction BEFORE DELETE ON financial.wager_transactions FOR EACH ROW EXECUTE FUNCTION financial.reject_history_change();
CREATE TRIGGER preserve_outbox BEFORE DELETE ON financial.outbox_messages FOR EACH ROW EXECUTE FUNCTION financial.reject_history_change();
CREATE TRIGGER no_wallet_truncate BEFORE TRUNCATE ON financial.wallets FOR EACH STATEMENT EXECUTE FUNCTION financial.reject_history_change();
CREATE TRIGGER no_transaction_truncate BEFORE TRUNCATE ON financial.wager_transactions FOR EACH STATEMENT EXECUTE FUNCTION financial.reject_history_change();
CREATE TRIGGER no_ledger_truncate BEFORE TRUNCATE ON financial.wallet_ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION financial.reject_history_change();
CREATE TRIGGER no_outbox_truncate BEFORE TRUNCATE ON financial.outbox_messages FOR EACH STATEMENT EXECUTE FUNCTION financial.reject_history_change();

CREATE CONSTRAINT TRIGGER wallet_transition AFTER INSERT OR UPDATE ON financial.wallets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION financial.check_wallet_transition();
CREATE CONSTRAINT TRIGGER ledger_chain AFTER INSERT ON financial.wallet_ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION financial.check_ledger_chain();
CREATE CONSTRAINT TRIGGER transaction_integrity AFTER INSERT OR UPDATE ON financial.wager_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION financial.check_transaction();
CREATE CONSTRAINT TRIGGER outbox_fact AFTER INSERT ON financial.outbox_messages
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION financial.check_outbox_fact();

GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA financial TO wager_app;
GRANT UPDATE (balance, version, updated_at) ON financial.wallets TO wager_app;
GRANT UPDATE (status, reference_transaction_id, failure_code, result, processed_at, completed_at)
  ON financial.wager_transactions TO wager_app;
GRANT UPDATE (attempts, next_attempt_at, published_at, claim_token, lease_until, suspended_at)
  ON financial.outbox_messages TO wager_app;
`;
