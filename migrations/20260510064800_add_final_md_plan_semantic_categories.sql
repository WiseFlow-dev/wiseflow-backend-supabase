-- Final MD-plan semantic category ontology coverage.
-- Adds / updates general category ontology rows not covered by the earlier 41-category pass.

begin;

insert into public.category_ontology (
  category_key,
  side,
  section,
  parent_concept,
  definition,
  multilingual_hints,
  examples,
  is_active,
  seed_version,
  updated_at
)
values
('Beauty & Cosmetics', 'expense', 'Shopping', 'Beauty', 'Beauty, cosmetics, skincare, makeup, and personal beauty retail purchases.', $json$["beauty","cosmetics","kecantikan","kosmetik","làm đẹp","makeup","mỹ phẩm","Sephora","solekan","trang điểm","Ulta","化妝品","美容"]$json$::jsonb, $json$["Sephora","Watsons Beauty"]$json$::jsonb, true, '2026-05-phase2-v6-full-md-semantics', now()),
('Clothing', 'expense', 'Shopping', 'Apparel', 'Clothing, apparel, fashion retail, and garment purchases.', $json$["apparel","baju","clothing","damit","fashion","fesyen","H&M","pakaian","quần áo","Shein","thời trang","Uniqlo","Zara","服裝","衣服"]$json$::jsonb, $json$["Zara","H&M"]$json$::jsonb, true, '2026-05-phase2-v6-full-md-semantics', now()),
('Doctor Visits', 'expense', 'Health', 'Medical Care', 'Doctor visits, clinics, outpatient medical care, consultations, and non-dental medical appointments.', $json$["bác sĩ","clinic","doctor","dokter","doktor","klinik","medical center","phòng khám","physician","pusat medis","pusat perubatan","trung tâm y tế","urgent care","診所","醫生","醫療中心"]$json$::jsonb, $json$["Medical Clinic","Doctor Consultation"]$json$::jsonb, true, '2026-05-phase2-v6-full-md-semantics', now()),
('Electronics', 'expense', 'Shopping', 'Electronics', 'Consumer electronics, computer hardware, devices, accessories, and tech retail purchases.', $json$["Apple","Best Buy","camera","computer","điện tử","electronics","elektronik","kamera","komputer","máy ảnh","máy tính","Micro Center","Newegg","SparkFun","相機","電子","電腦"]$json$::jsonb, $json$["Best Buy","Apple Store"]$json$::jsonb, true, '2026-05-phase2-v6-full-md-semantics', now()),
('Furniture', 'expense', 'Home', 'Furniture', 'Furniture, home decor, mattresses, household furnishings, and home goods.', $json$["furnitur","furniture","ghế sofa","home furnishings","IKEA","kasur","mattress","mebel","nệm","nội thất","perabot","sofa","tilam","傢俬","家具","床褥","沙發"]$json$::jsonb, $json$["IKEA","Ashley Furniture"]$json$::jsonb, true, '2026-05-phase2-v6-full-md-semantics', now()),
('Games', 'expense', 'Entertainment', 'Gaming', 'Video games, game stores, console subscriptions, and in-game purchases.', $json$["Epic Games","game","gaming","laro","Nintendo","permainan","PlayStation","Roblox","Steam","trò chơi","Xbox","遊戲"]$json$::jsonb, $json$["Steam","PlayStation Network"]$json$::jsonb, true, '2026-05-phase2-v6-full-md-semantics', now()),
('Home Improvement', 'expense', 'Home', 'Home Improvement', 'Hardware, renovation, home repair, DIY materials, and home improvement store purchases.', $json$["alat","cat","dụng cụ","hardware","Home Depot","Lowe's","paint","perkakas","perkakasan","pintura","renovasi","renovation","sơn","sửa nhà","toko bangunan","tools","vật liệu xây dựng","五金","工具","油漆","裝修"]$json$::jsonb, $json$["Home Depot","Bunnings"]$json$::jsonb, true, '2026-05-phase2-v6-full-md-semantics', now()),
('Mortgage', 'expense', 'Housing', 'Housing Payment', 'Mortgage and housing loan related charges when not better classified as a loan payment.', $json$["gadai janji","home loan","housing loan","KPR","kredit rumah","mortgage","pinjaman perumahan","thế chấp","vay mua nhà","房貸","按揭"]$json$::jsonb, $json$["Mortgage Servicing"]$json$::jsonb, true, '2026-05-phase2-v6-full-md-semantics', now()),
('Shoes', 'expense', 'Shopping', 'Footwear', 'Shoes, sneakers, footwear stores, and shoe-related purchases.', $json$["Adidas","Foot Locker","footwear","giày","giày thể thao","kasut","Nike","sapatos","sepatu","shoes","sneakers","運動鞋","鞋"]$json$::jsonb, $json$["Nike","Foot Locker"]$json$::jsonb, true, '2026-05-phase2-v6-full-md-semantics', now()),
('Shopping', 'expense', 'Lifestyle', 'Retail', 'General retail shopping for consumer goods.', $json$["AliExpress","Amazon","åº—é“º","belanja","beli-belah","Bukalapak","eBay","HKTVmall","Lazada","mua sắm","retail","Shopee","shopping","Target","Tiki","Tokopedia","Walmart","淘寶","網購","購物"]$json$::jsonb, $json$["Amazon"]$json$::jsonb, true, '2026-05-phase2-v6-full-md-semantics', now()),
('Software & Apps', 'expense', 'Digital', 'Software', 'Software subscriptions, app stores, SaaS tools, cloud apps, and productivity app purchases.', $json$["Adobe","aplikasi","app","App Store","Canva","ChatGPT","Dropbox","Figma","Google Play","iCloud","Microsoft","Notion","OpenAI","perangkat lunak","perisian","phần mềm","software","ứng dụng","應用程式","軟件"]$json$::jsonb, $json$["Apple App Store","Adobe"]$json$::jsonb, true, '2026-05-phase2-v6-full-md-semantics', now()),
('Travel', 'expense', 'Travel', 'General Travel', 'General travel costs such as tours, visas, passports, luggage, travel agencies, and trip costs when a more specific travel category does not fit.', $json$["bagasi","du lịch","excursion","hành lý","hộ chiếu","lawatan","luggage","paspor","pasport","passport","pelancongan","perjalanan","tour","travel","travel agency","trip","tur","visa","visa fee","wisata","旅行社","旅遊","簽證","行李","護照"]$json$::jsonb, $json$["Travel Agency","Visa Fee"]$json$::jsonb, true, '2026-05-phase2-v6-full-md-semantics', now())
on conflict (category_key, side)
do update set
  section = excluded.section,
  parent_concept = excluded.parent_concept,
  definition = excluded.definition,
  multilingual_hints = excluded.multilingual_hints,
  examples = excluded.examples,
  is_active = true,
  seed_version = excluded.seed_version,
  updated_at = now();

commit;
