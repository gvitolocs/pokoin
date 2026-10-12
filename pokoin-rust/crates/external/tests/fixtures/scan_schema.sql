-- Live shape of the Scan Connect tables (pg_dump --schema-only, 2026-10-12),
-- without the guard trigger. Used by tests/scan_rows_flow.rs.
CREATE TABLE public.scan_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    seller_uid text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    defaults jsonb DEFAULT '{}'::jsonb NOT NULL,
    defaults_version integer DEFAULT 1 NOT NULL,
    defaults_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    item_seq bigint DEFAULT 0 NOT NULL,
    item_position integer DEFAULT 0 NOT NULL,
    submit_key text,
    submit_result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    submitted_at timestamp with time zone,
    CONSTRAINT scan_batches_defaults_version_check CHECK ((defaults_version >= 1)),
    CONSTRAINT scan_batches_status_check CHECK ((status = ANY (ARRAY['open'::text, 'submitted'::text, 'discarded'::text])))
);
CREATE TABLE public.scan_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    batch_id uuid NOT NULL,
    seller_uid text NOT NULL,
    scan_event_id uuid,
    session_id uuid,
    client_sequence integer,
    captured_at timestamp with time zone,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    recognition_state text NOT NULL,
    recognition jsonb DEFAULT '{}'::jsonb NOT NULL,
    defaults_version integer,
    defaults_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    image bytea,
    timings jsonb DEFAULT '{}'::jsonb NOT NULL,
    seq bigint NOT NULL,
    "position" double precision NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    merged_into uuid,
    reviewed boolean DEFAULT false NOT NULL,
    card_id text,
    card_name text DEFAULT ''::text NOT NULL,
    set_name text DEFAULT ''::text NOT NULL,
    collector_number text DEFAULT ''::text NOT NULL,
    image_url text DEFAULT ''::text NOT NULL,
    nationality text DEFAULT ''::text NOT NULL,
    condition text DEFAULT 'NM'::text NOT NULL,
    language text DEFAULT 'EN'::text NOT NULL,
    foil_state text DEFAULT 'standard'::text NOT NULL,
    first_edition boolean DEFAULT false NOT NULL,
    signed boolean DEFAULT false NOT NULL,
    altered boolean DEFAULT false NOT NULL,
    graded boolean DEFAULT false NOT NULL,
    grading_company text,
    grade text,
    certification_id text,
    location text DEFAULT ''::text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    price_pkn numeric,
    price_suggested boolean DEFAULT false NOT NULL,
    seller_comment text DEFAULT ''::text NOT NULL,
    listing_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scan_items_image_check CHECK (((image IS NULL) OR (octet_length(image) <= 60000))),
    CONSTRAINT scan_items_price_pkn_check CHECK (((price_pkn IS NULL) OR (price_pkn > (0)::numeric))),
    CONSTRAINT scan_items_quantity_check CHECK (((quantity >= 1) AND (quantity <= 99))),
    CONSTRAINT scan_items_recognition_state_check CHECK ((recognition_state = ANY (ARRAY['matched'::text, 'ambiguous'::text, 'unmatched'::text, 'manual'::text]))),
    CONSTRAINT scan_items_status_check CHECK ((status = ANY (ARRAY['active'::text, 'removed'::text, 'merged'::text, 'submitted'::text])))
);
CREATE TABLE public.scan_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    seller_uid text NOT NULL,
    batch_id uuid NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    end_reason text,
    paused boolean DEFAULT false NOT NULL,
    phone_token_hash text,
    phone_label text DEFAULT ''::text NOT NULL,
    phone_connected_at timestamp with time zone,
    phone_last_seen_at timestamp with time zone,
    phone_scans integer DEFAULT 0 NOT NULL,
    last_scan_at timestamp with time zone,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    CONSTRAINT scan_sessions_end_reason_check CHECK (((end_reason IS NULL) OR (end_reason = ANY (ARRAY['completed'::text, 'expired'::text, 'logout'::text, 'replaced'::text, 'discarded'::text])))),
    CONSTRAINT scan_sessions_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'connected'::text, 'ended'::text])))
);
ALTER TABLE ONLY public.scan_batches
    ADD CONSTRAINT scan_batches_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.scan_items
    ADD CONSTRAINT scan_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.scan_items
    ADD CONSTRAINT scan_items_scan_event_id_key UNIQUE (scan_event_id);
ALTER TABLE ONLY public.scan_sessions
    ADD CONSTRAINT scan_sessions_phone_token_hash_key UNIQUE (phone_token_hash);
ALTER TABLE ONLY public.scan_sessions
    ADD CONSTRAINT scan_sessions_pkey PRIMARY KEY (id);
CREATE INDEX scan_batches_seller_open_idx ON public.scan_batches USING btree (seller_uid, status, updated_at DESC);
CREATE INDEX scan_items_batch_position_idx ON public.scan_items USING btree (batch_id, "position");
CREATE INDEX scan_items_batch_seq_idx ON public.scan_items USING btree (batch_id, seq);
CREATE INDEX scan_sessions_batch_idx ON public.scan_sessions USING btree (batch_id, created_at DESC);
CREATE INDEX scan_sessions_seller_live_idx ON public.scan_sessions USING btree (seller_uid, status) WHERE (status <> 'ended'::text);
ALTER TABLE ONLY public.scan_items
    ADD CONSTRAINT scan_items_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.scan_batches(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.scan_items
    ADD CONSTRAINT scan_items_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES public.scan_items(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.scan_items
    ADD CONSTRAINT scan_items_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.scan_sessions(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.scan_sessions
    ADD CONSTRAINT scan_sessions_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.scan_batches(id) ON DELETE CASCADE;
