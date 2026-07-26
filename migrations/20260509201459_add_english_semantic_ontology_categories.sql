-- English ontology expansion for semantic resolver coverage.
-- Adds missing active rows used by ai-categorize-batch prompt construction.
insert into public.category_ontology (
  category_key,
  side,
  section,
  parent_concept,
  definition,
  multilingual_hints,
  examples,
  is_active
)
values
('Food Delivery', 'expense', 'Food', 'Delivery', 'Delivered meals and app-based food orders.', '["food delivery","doordash","uber eats","grubhub","deliveroo"]'::jsonb, '["Uber Eats"]'::jsonb, true),
('Hotels & Lodging', 'expense', 'Travel', 'Lodging', 'Hotels, resorts, inns, and short-stay lodging.', '["hotel","lodging","resort","motel","airbnb"]'::jsonb, '["Marriott"]'::jsonb, true),
('Rideshare', 'expense', 'Transport', 'Ride Service', 'App rides, taxi-like ride services, and point-to-point paid rides.', '["uber","lyft","rideshare","taxi","grab"]'::jsonb, '["Uber"]'::jsonb, true),
('Parking', 'expense', 'Transport', 'Parking', 'Parking lots, garages, parking meters, and parking operators.', '["parking","garage","car park","parking meter"]'::jsonb, '["Wilson Parking"]'::jsonb, true),
('Tolls', 'expense', 'Transport', 'Road Fees', 'Road tolls and expressway charges.', '["toll","tollway","expressway","road charge","e-tag"]'::jsonb, '["EZ Pass"]'::jsonb, true),
('Gas & Fuel', 'expense', 'Transport', 'Fuel', 'Vehicle fuel purchases and fuel station payments.', '["gas","fuel","petrol","diesel","shell"]'::jsonb, '["Shell"]'::jsonb, true),
('Rent', 'expense', 'Housing', 'Housing Payment', 'Recurring housing rent paid to landlord or property manager.', '["rent","apartment rent","lease","landlord","tenant"]'::jsonb, '["Monthly Rent"]'::jsonb, true),
('Electricity', 'expense', 'Utilities', 'Power Utility', 'Electricity bills and power utility charges.', '["electricity","electric bill","power bill","utility power","kwh"]'::jsonb, '["Electric Utility"]'::jsonb, true),
('Water', 'expense', 'Utilities', 'Water Utility', 'Water service and municipal water utility charges.', '["water bill","water utility","water services","waterworks"]'::jsonb, '["Water Utility"]'::jsonb, true),
('Gas & Heating', 'expense', 'Utilities', 'Gas Utility', 'Natural gas and city gas service charges for home or business.', '["gas utility","natural gas","gas bill","city gas"]'::jsonb, '["Gas Utility"]'::jsonb, true),
('Prescriptions', 'expense', 'Health', 'Pharmacy', 'Prescription and pharmacy retail health purchases.', '["pharmacy","drugstore","prescription","walgreens","cvs"]'::jsonb, '["CVS Pharmacy"]'::jsonb, true),
('Dental Care', 'expense', 'Health', 'Dental', 'Dentist, dental clinic, and oral-care service payments.', '["dental","dentist","orthodontist"]'::jsonb, '["Dental Clinic"]'::jsonb, true),
('Vision Care', 'expense', 'Health', 'Vision', 'Optical stores, vision care, and eye health services.', '["optical","vision","glasses","contact lenses","optometrist"]'::jsonb, '["Optical Center"]'::jsonb, true),
('Fitness & Gym', 'expense', 'Health', 'Fitness', 'Gym memberships, fitness subscriptions, and exercise studios.', '["gym","fitness","yoga","pilates","planet fitness"]'::jsonb, '["Anytime Fitness"]'::jsonb, true),
('Wellness & Spa', 'expense', 'Health', 'Wellness', 'Spa, massage, and wellness treatment services.', '["spa","massage","wellness","sauna"]'::jsonb, '["Wellness Spa"]'::jsonb, true),
('Credit Card Fees', 'expense', 'Banking', 'Card Fees', 'Credit card fees such as annual, late, and foreign transaction fees.', '["late fee","annual fee","cash advance fee","foreign transaction fee","credit card fee"]'::jsonb, '["Card Annual Fee"]'::jsonb, true),
('Taxes', 'expense', 'Government', 'Tax', 'General tax payments to tax authorities.', '["tax","irs","revenue service","tax payment"]'::jsonb, '["Tax Payment"]'::jsonb, true),
('Property Tax', 'expense', 'Government', 'Property Tax', 'Taxes assessed on property ownership and real estate.', '["property tax","real estate tax"]'::jsonb, '["Property Tax Bill"]'::jsonb, true),
('Bonus', 'income', 'Income', 'Payroll', 'Bonus and commission income from employer or contract work.', '["bonus","commission"]'::jsonb, '["Quarterly Bonus"]'::jsonb, true),
('Interest', 'income', 'Income', 'Yield', 'Interest income credited from savings, deposits, or account balances.', '["interest earned","interest paid","intrst pymnt","int earned"]'::jsonb, '["INTRST PYMNT"]'::jsonb, true),
('Dividends', 'income', 'Income', 'Investment Income', 'Dividend payouts and related investment distribution income.', '["dividend","div reinvest","div payout"]'::jsonb, '["Dividend Payout"]'::jsonb, true),
('Cashback & Rewards', 'income', 'Income', 'Rewards', 'Cashback, rebate, and rewards redemption credits.', '["cashback","reward","points redemption","rebate"]'::jsonb, '["Cashback Reward"]'::jsonb, true),
('Rental Income', 'income', 'Income', 'Property Income', 'Income received from tenants or rental contracts.', '["rent received","rental income","tenant payment"]'::jsonb, '["Tenant Payment"]'::jsonb, true),
('Freelance', 'income', 'Income', 'Business Income', 'Independent work, client invoices, and business payout income.', '["invoice","client payment","freelance","contract","stripe payout","square payout","shopify payout"]'::jsonb, '["Client Invoice Payment"]'::jsonb, true),
('Side Hustle', 'income', 'Income', 'Business Income', 'Income from side jobs, extra gigs, and non-primary hustle work.', '["invoice","client payment","freelance","contract","stripe payout","square payout","shopify payout"]'::jsonb, '["Side Gig Payment"]'::jsonb, true),
('Business', 'income', 'Income', 'Business Income', 'Business revenue, company payouts, and business client settlements.', '["invoice","client payment","freelance","contract","stripe payout","square payout","shopify payout"]'::jsonb, '["Business Client Payment"]'::jsonb, true)
on conflict (category_key, side)
do update set
  section = excluded.section,
  parent_concept = excluded.parent_concept,
  definition = excluded.definition,
  multilingual_hints = excluded.multilingual_hints,
  examples = excluded.examples,
  is_active = true,
  updated_at = now();

