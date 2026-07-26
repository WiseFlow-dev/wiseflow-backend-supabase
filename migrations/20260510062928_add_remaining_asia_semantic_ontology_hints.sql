-- Final multilingual ontology hints for the Phase 7 semantic category mapping plan.
-- Covers English, Traditional Chinese / Hong Kong, Indonesian, Vietnamese, Malay, and Filipino / Tagalog.

begin;

update public.category_ontology
set multilingual_hints = $json$["administrasi bank","atm fee","atm費","bank fee","bayad sa bangko","biaya admin","biaya atm","biaya bank","biaya layanan","caj atm","caj bank","caj perkhidmatan","fi bank","maintenance fee","monthly service fee","overdraft fee","phi atm","phi chuyen khoan","phi dich vu","phi duy tri","phi ngan hang","service fee","yuran bank","手續費","服務費","透支費","銀行費"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Bank Fees'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["bo coffee","ca phe","cafe","cappuccino","coffee","coffee bean","costa coffee","espresso","highlands coffee","janji jiwa","kafe","kape","kopi","kopi kenangan","latte","peets","phuc long","starbucks","zus coffee","咖啡","咖啡店","太平洋咖啡","星巴克"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Coffee & Cafes'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["annual fee","bayad sa credit card","biaya kartu kredit","caj kad kredit","caj lewat bayar","cash advance fee","credit card fee","denda keterlambatan","fi kad kredit","foreign transaction fee","iuran tahunan","lai phat cham tra","late fee","late fee kartu kredit","penalty fee","phi the tin dung","phi thuong nien","phi tra cham","yuran tahunan","信用卡年費","海外交易費","滯納金","現金透支費"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Credit Card Fees'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["behel","braces","clinic ng ngipin","dental","dentist","dentista","dokter gigi","doktor gigi","kham rang","klinik gigi","ngipin","nha khoa","nieng rang","orthodontist","pendakap gigi","perawatan gigi","rang","rawatan gigi","scaling gigi","tay trang rang","牙科","牙醫","箍牙"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Dental Care'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["bayad kuryente","bayaran elektrik","bil elektrik","bill sa kuryente","dien","electric","electricity","elektrik","evn","hoa don dien","kuryente","kwh","listrik","meralco","pln","power bill","tagihan listrik","tien dien","tnb","token listrik","utility power","中電","港燈","電力","電費"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Electricity'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["a&w","burger king","cepat saji","chowking","do an nhanh","fast food","jollibee","kfc","lotteria","makanan segera","mcdonald","mcdonalds","popeyes","subway","taco bell","texas chicken","wendys","快餐","漢堡王","肯德基","麥當勞"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Fast Food'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["anytime fitness","fitness","gim","gym","hoi vien gym","keahlian gim","la fitness","membership gym","membership sa gym","phong gym","pilates","planet fitness","pusat kebugaran","workout","yoga","健身","健身房","普拉提","瑜伽"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Fitness & Gym'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["air ticket","airasia","airline","airport","airways","american airlines","bamboo airways","bandara","boarding","cathay pacific","cebu pacific","chuyen bay","citilink","delta","eroplano","flight","garuda","hang khong","lapangan terbang","lion air","malaysia airlines","maskapai","pal","penerbangan","philippine airlines","san bay","singapore airlines","syarikat penerbangan","ticket sa eroplano","tiket kapal terbang","tiket pesawat","united airlines","ve may bay","vietjet","vietnam airlines","國泰","機票","港航","登機","航班","航空","香港快運"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Flights'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["antar makanan","baemin","dat mon","deliveroo","delivery makanan","delivery ng pagkain","doordash","food delivery","foodpanda","giao do an","gofood","grabfood","grubhub","hantar makanan","padala ng pagkain","penghantaran makanan","pesan antar","pesanan makanan","ship do an","shopeefood","uber eats","ubereats","外賣","戶戶送","送餐"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Food Delivery'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["bahan bakar","bbm","bensin","bhp","bp","caltex","cay xang","chevron","dau diesel","diesel","esso","exxon","fuel","gas","gas station","gasolina","minyak","nhien lieu","pertamina","petrol","petrolimex","petron","petronas","shell","solar","spbu","stesen minyak","xang","加油","柴油","汽油","油站"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Gas & Fuel'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["binh gas","city gas","cooking gas","doi gas","elpiji","gas","gas bill","gas memasak","gas rumah","gas utility","gasul","isi ulang gas","khi dot","lpg","natural gas","tangke ng gas","tong gas","towngas","煤氣","煤氣費","燃氣","石油氣"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Gas & Heating'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["aldi","alfamart","bach hoa xanh","bahan makanan","barang dapur","citysuper","coopmart","cua hang tien loi","giant","grocery","hypermart","indomaret","jaya grocer","kedai runcit","kroger","lotus","market place","minimarket","palengke","pasar raya","puregold","ranch market","robinsons supermarket","safeway","sieu thi","sm supermarket","supermarket","tap hoa","trader joes","walmart grocery","whole foods","winmart","惠康","百佳","超市","雜貨"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Groceries'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["accommodation","airbnb","booking hotel","booking ng hotel","booking.com","dat phong","hilton","holiday inn","homestay","hotel","hyatt","inn","khach san","lodging","luu tru","marriott","motel","nha nghi","oyo","penginapan","reddoorz","resor","resort","suites","tempahan bilik","tuluyan","villa","住宿","度假村","旅館","民宿","酒店"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Hotels & Lodging'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["asuransi","bao hiem","bayad seguro","hop dong bao hiem","insurance","insurans","phi bao hiem","policy","polis","polisi","premi","premi asuransi","premium","premium insurans","seguro","保單","保費","保險"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Insurance (Other)'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["bayad sa internet","bil internet","biznet","broadband","converge","fiber","fibre","first media","fpt telecom","hgc","hkbn","hoa don internet","indihome","internet","maxis fibre","myrepublic","netvigator","pldt","sky fiber","tagihan internet","time internet","unifi","verizon fios","viettel internet","vnpt","wifi","xfinity","上網","互聯網","寬頻","網絡"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Internet'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["acara","bioskop","cgv","cinema","concert","event","event ticket","imax","konser","konsert","loket","lotte cinema","movie","pawagam","rap phim","sine","sm cinema","su kien","theater","theatre","ticket","ticketmaster","tiket event","tiket nonton","tiket wayang","ve xem phim","戲院","活動票","演唱會","門票","電影"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Movies & Events'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["bai do xe","bayad sa parking","bayaran parkir","biaya parkir","car park","garage","garahe","gedung parkir","giu xe","gui xe","paradahan","parking","parking meter","parkir","phi gui xe","tempat letak kereta","tempat parkir","wilson parking","停車","停車場","咪錶","泊車"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Parking'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["3hk","at&t","bil telefon","birdie","celcom","cellular","csl","data","data di dong","data mudah alih","dien thoai","digi","dito","globe","goi cuoc","indosat","load","maxis","mobifone","mobile","mobile data","nap tien","paket data","phone","prepaid","prepaid load","pulsa","singtel","smart","smartfren","smt","t mobile","tagihan ponsel","telefon","telkomsel","tmobile","tri","umobile","verizon","viettel","vinaphone","wireless","xl","手機","流動","通訊","電訊","電話費"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Phone'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["ankhang","apotek","botika","century healthcare","cvs","don thuoc","drugstore","farmasi","gamot","guardian","kimia farma","long chau","mercury drug","nha thuoc","obat","pharmacity","pharmacy","prescription","preskripsi","resep","reseta","rite aid","thuoc","ubat","ubat klinik","walgreens","watsons","watsons pharmacy","屈臣氏","萬寧","藥局","藥房","處方","配藥"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Prescriptions'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["amilyar","assessment tax","buwis sa lupa","cukai hartanah","cukai pintu","cukai tanah","pajak bumi bangunan","pajak properti","pajak rumah","pbb","property tax","real estate tax","real property tax","thue bat dong san","thue nha dat","thue tai san","地稅","差餉","物業稅"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Property Tax'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["angkutan umum","bas","beep card","bus","giao thong cong cong","jeep","kartu transportasi","kereta","krl","ktm","lrt","metro","monorel","mrt","mtr","octopus","pampublikong transportasyon","pengangkutan awam","rail","subway","tau","tau dien","touch n go","train","transit","transjakarta","tren","ve xe","xe buyt","八達通","地鐵","巴士","渡輪","港鐵","火車","電車"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Public Transit'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["apartment rent","bayad upa","bayar sewa","chu nha","deposit sewa","kontrakan","kos","kost","landlord","lease","pemilik kos","rent","rumah sewa","sewa","tenant","thue can ho","thue nha","tien phong","tien thue nha","tuan rumah","uang sewa","upa","業主","租屋","租約","租金"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Rent'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["bistro","bua an","diner","dining","grill","kainan","karinderya","kedai makan","makan di tempat","makan luar","mamak","nha hang","pizza","quan an","ramen","restaurant","restawran","restoran","rumah makan","steakhouse","sushi","warung","茶餐廳","食肆","飯店","餐廳"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Restaurants'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["angkas","be","bluebird","dat xe","ehailing","gocar","gojek","goride","grab","joyride","kereta sewa pemandu","lyft","mycar","ojek","ride","ride hailing","rideshare","sakay","taksi","taxi","teksi","uber","xe om","滴滴","的士","網約車"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Rideshare'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["apple tv","astro go","disney","disney hotstar","disney plus","disney+","fpt play","hulu","langganan musik","max","netflix","penstriman","spotify","streaming","subscription","vidio","vieon","viu","vivamax","youtube premium","zing mp3","串流","影音平台"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Streaming Services'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["bayad buwis","bayaran cukai","bir","buwis","cukai","ditjen pajak","hasil","irs","lhdn","ma so thue","nombor cukai","nop thue","npwp","pajak","pembayaran pajak","revenue service","setoran pajak","tax","tax payment","thue","tong cuc thue","交稅","政府稅","稅務局","稅款"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Taxes'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["autosweep","e toll","e-tag","easytrip","etc toll","etoll","expressway","ez pass","gerbang tol","jalan tol","kartu tol","lebuhraya","nlex","phi cau duong","rfid","rfid toll","road charge","skyway","slex","smarttag","tol","toll","tollway","touch n go toll","tram thu phi","ve duong bo","收費公路","路費","隧道費","高速費"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Tolls'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["cermin mata","contact lens","contact lenses","eye checkup","glasses","kacamata","kanta lekap","kinh ap trong","kinh mat","lensa kontak","mat kinh","optical","optik","optometrist","pemeriksaan mata","periksa mata","salamin","thi luc","vision","vision care","眼鏡","視光","視力","隱形眼鏡","驗眼"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Vision Care'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["air minum","air selangor","bayad tubig","bayaran air","bekalan air","bil air","bill sa tubig","cap nuoc","hoa don nuoc","manila water","maynilad","nuoc","pdam","rekening air","tagihan air","tien nuoc","tubig","water bill","water services","water utility","waterworks","水務","水費","食水"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Water'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["cham soc suc khoe","masahe","massage","pijat","refleksi","refleksologi","salon spa","sauna","spa","urut","wellness","xong hoi","按摩","桑拿","水療","養生"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Wellness & Spa'
  and side = 'expense';

update public.category_ontology
set multilingual_hints = $json$["bonus","commission","elaun prestasi","hoa hong","incentive","insentif","komisen","komisi","komisyon","performance bonus","thuong","thuong doanh so","tunjangan kinerja","佣金","獎金","花紅"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Bonus'
  and side = 'income';

update public.category_ontology
set multilingual_hints = $json$["ban hang","bayad ng kliyente","bayaran klien","benta","client payment","contract","freelance","hoa don","hop dong","invoice","invois","jualan","kerja sampingan","khach hang thanh toan","kita sa negosyo","kontrak","kontrata","pemasukan bisnis","pembayaran klien","pendapatan perniagaan","pendapatan sampingan","pendapatan usaha","penghasilan sampingan","penjualan","raket","shopify payout","side hustle","sideline","square payout","stripe payout","thu nhap kinh doanh","thu nhap phu","usaha sampingan","viec phu","合約款","商業收入","客戶付款","接案","營業收入","自由工作"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Business'
  and side = 'income';

update public.category_ontology
set multilingual_hints = $json$["cashback","diem thuong","ganjaran","gantimpala","hadiah kartu","hoan tien the","mata ganjaran","phan thuong","poin","points","points redemption","pulangan tunai","rebate","reward","回贈","現金回贈","積分兌換","返現"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Cashback & Rewards'
  and side = 'income';

update public.category_ontology
set multilingual_hints = $json$["bayad dibidendo","bayaran dividen","chi tra co tuc","co tuc","dibidendo","div payout","div reinvest","dividen","dividend","dividend payment","pembagian dividen","pembahagian dividen","派息","紅利","股息"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Dividends'
  and side = 'income';

update public.category_ontology
set multilingual_hints = $json$["ban hang","bayad ng kliyente","bayaran klien","benta","client payment","contract","freelance","hoa don","hop dong","invoice","invois","jualan","kerja sampingan","khach hang thanh toan","kita sa negosyo","kontrak","kontrata","pemasukan bisnis","pembayaran klien","pendapatan perniagaan","pendapatan sampingan","pendapatan usaha","penghasilan sampingan","penjualan","raket","shopify payout","side hustle","sideline","square payout","stripe payout","thu nhap kinh doanh","thu nhap phu","usaha sampingan","viec phu","合約款","商業收入","客戶付款","接案","營業收入","自由工作"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Freelance'
  and side = 'income';

update public.category_ontology
set multilingual_hints = $json$["bank interest","bunga deposito","bunga tabungan","faedah deposit","faedah simpanan","int earned","interes","interest earned","interest income","interest paid","intrst pymnt","kita sa interes","lai ngan hang","lai tien gui","pendapatan bunga","pendapatan faedah","thu nhap lai","tien lai","tubo","利息","利息收入","存款利息"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Interest'
  and side = 'income';

update public.category_ontology
set multilingual_hints = $json$["balik bayad","bayaran balik","dana kembali","giao dich dao nguoc","hoan tien","hoan tra","ibinalik na bayad","money back","pembalikan transaksi","pemulangan wang","pengembalian dana","refund","returned payment","reversal","transaksi dibalikkan","交易撤銷","回水","退款","退費"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Refund'
  and side = 'income';

update public.category_ontology
set multilingual_hints = $json$["bayad ng umuupa","bayaran penyewa","khach thue tra tien","kita sa upa","natanggap na upa","pembayaran penyewa","pendapatan sewa","rent received","rental income","sewa masuk","tenant payment","terima sewa","thu nhap cho thue","tien thue nhan","uang sewa masuk","收租","租客付款","租金收入"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Rental Income'
  and side = 'income';

update public.category_ontology
set multilingual_hints = $json$["bayaran gaji","direct deposit","employer","gaji","luong","payroll","pembayaran gaji","sahod","salary","slip gaji","suweldo","sweldo","tien luong","tra luong","upah","wages","人工","出糧","工資","薪酬","薪金"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Salary'
  and side = 'income';

update public.category_ontology
set multilingual_hints = $json$["ban hang","bayad ng kliyente","bayaran klien","benta","client payment","contract","freelance","hoa don","hop dong","invoice","invois","jualan","kerja sampingan","khach hang thanh toan","kita sa negosyo","kontrak","kontrata","pemasukan bisnis","pembayaran klien","pendapatan perniagaan","pendapatan sampingan","pendapatan usaha","penghasilan sampingan","penjualan","raket","shopify payout","side hustle","sideline","square payout","stripe payout","thu nhap kinh doanh","thu nhap phu","usaha sampingan","viec phu","合約款","商業收入","客戶付款","接案","營業收入","自由工作"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Side Hustle'
  and side = 'income';

update public.category_ontology
set multilingual_hints = $json$["bayaran balik cukai","hoan thue","hoan tien thue","ibinalik na buwis","irs refund","pengembalian pajak","refund cukai","refund sa buwis","restitusi pajak","revenue refund","tax refund","稅務退款","退稅"]$json$::jsonb,
    seed_version = '2026-05-phase2-v4-asia-semantics',
    updated_at = now()
where category_key = 'Tax Refund'
  and side = 'income';

commit;
