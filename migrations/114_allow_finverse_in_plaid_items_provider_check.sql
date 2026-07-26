ALTER TABLE public.plaid_items
DROP CONSTRAINT IF EXISTS plaid_items_provider_check;

ALTER TABLE public.plaid_items
ADD CONSTRAINT plaid_items_provider_check
CHECK (provider = ANY (ARRAY['plaid'::text, 'gocardless'::text, 'finverse'::text]));
