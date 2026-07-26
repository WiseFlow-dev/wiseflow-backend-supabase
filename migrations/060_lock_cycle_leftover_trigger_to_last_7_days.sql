-- Lock savings suggestion trigger window to the last 7 days of cycle.
UPDATE public.action_rule_settings
SET trigger_days_remaining = 7
WHERE rule_id = 'cycle_leftover_to_savings_wallet_v1';

