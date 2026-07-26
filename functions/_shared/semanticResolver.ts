import { normalizeMerchant } from "./normalize.ts";

export type SemanticResolverAiInput = {
  broadConcept?: string | null;
  merchantClean?: string | null;
};

export type SemanticResolverDecision = {
  categoryKey: string | null;
  confidence: number;
  reason: string;
  source: "semantic_resolver";
};

function normCategoryText(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function pickFirstAllowed(allowed: string[], preferred: string[]): string | null {
  const allowedDedup = Array.from(new Set(allowed.map((v) => String(v ?? "").trim()).filter(Boolean)));
  for (const candidate of preferred) {
    const cNorm = normCategoryText(candidate);
    for (const a of allowedDedup) {
      const aNorm = normCategoryText(a);
      if (aNorm === cNorm) return a;
    }
  }
  for (const candidate of preferred) {
    const cNorm = normCategoryText(candidate);
    for (const a of allowedDedup) {
      const aNorm = normCategoryText(a);
      if (aNorm.includes(cNorm) || cNorm.includes(aNorm)) return a;
    }
  }
  return null;
}

function normalizeConcept(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function resolverCueText(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => normalizeMerchant(String(part ?? "")))
    .filter((part) => part.length > 0)
    .join(" ");
}

function hasResolverCue(text: string, cues: string[]): boolean {
  const matchesCue = (normalizedText: string, normalizedCue: string): boolean => {
    if (!normalizedCue) return false;
    const isAsciiWordCue = /^[a-z0-9]+$/.test(normalizedCue);
    if (!isAsciiWordCue) return normalizedText.includes(normalizedCue);
    const escaped = normalizedCue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(normalizedText);
  };

  return cues.some((cue) => {
    const normalizedConceptCue = normalizeConcept(cue);
    const normalizedMerchantCue = normalizeMerchant(cue);
    return Boolean(
      matchesCue(text, normalizedConceptCue) ||
      matchesCue(text, normalizedMerchantCue)
    );
  });
}

type SemanticRule = {
  preferred: string[];
  broadCues: string[];
  textCues: string[];
  confidence: number;
  reason: string;
};

const ENGLISH_SEMANTIC_RULES: SemanticRule[] = [
  {
    preferred: ["Flights"],
    broadCues: ["travel", "flight", "airline", "transport"],
    textCues: [
      "flight", "airline", "airways", "airport", "air ticket", "boarding",
      "united airlines", "delta", "american airlines", "cathay pacific", "singapore airlines"
    ],
    confidence: 0.93,
    reason: "english_flights_cues"
  },
  {
    preferred: ["Hotels & Lodging"],
    broadCues: ["travel", "hotel", "lodging", "vacation"],
    textCues: [
      "hotel", "resort", "lodging", "motel", "inn", "suites",
      "marriott", "hilton", "hyatt", "holiday inn", "airbnb", "booking.com"
    ],
    confidence: 0.93,
    reason: "english_hotels_cues"
  },
  {
    preferred: ["Rideshare"],
    broadCues: ["transport", "commute", "ride", "travel"],
    textCues: ["uber", "lyft", "rideshare", "ride", "taxi", "grab"],
    confidence: 0.92,
    reason: "english_rideshare_cues"
  },
  {
    preferred: ["Public Transit"],
    broadCues: ["transport", "commute", "travel", "transit"],
    textCues: ["metro", "subway", "bus", "train", "rail", "transit", "octopus", "mtr"],
    confidence: 0.92,
    reason: "english_public_transit_cues"
  },
  {
    preferred: ["Parking"],
    broadCues: ["transport", "car", "travel"],
    textCues: ["parking", "garage", "car park", "parking meter", "wilson parking"],
    confidence: 0.93,
    reason: "english_parking_cues"
  },
  {
    preferred: ["Tolls"],
    broadCues: ["transport", "car", "travel"],
    textCues: ["toll", "tollway", "expressway", "road charge", "e-tag", "ez pass"],
    confidence: 0.93,
    reason: "english_tolls_cues"
  },
  {
    preferred: ["Gas & Fuel"],
    broadCues: ["transport", "car", "fuel"],
    textCues: ["gas", "fuel", "petrol", "diesel", "shell", "bp", "chevron", "exxon"],
    confidence: 0.93,
    reason: "english_gas_fuel_cues"
  },
  {
    preferred: ["Coffee & Cafes"],
    broadCues: ["food", "dining", "coffee", "cafe"],
    textCues: ["coffee", "cafe", "espresso", "latte", "cappuccino", "starbucks", "costa coffee", "peets"],
    confidence: 0.92,
    reason: "english_coffee_cues"
  },
  {
    preferred: ["Fast Food"],
    broadCues: ["food", "dining", "restaurant"],
    textCues: ["mcdonalds", "burger king", "burger", "kfc", "taco bell", "wendys", "popeyes", "subway"],
    confidence: 0.93,
    reason: "english_fast_food_cues"
  },
  {
    preferred: ["Food Delivery"],
    broadCues: ["food", "dining", "delivery"],
    textCues: ["doordash", "uber eats", "grubhub", "deliveroo", "food delivery"],
    confidence: 0.93,
    reason: "english_food_delivery_cues"
  },
  {
    preferred: ["Groceries"],
    broadCues: ["food", "household", "grocery"],
    textCues: [
      "grocery", "groceries", "supermarket", "mart", "best mart", "wellcome",
      "whole foods", "trader joes", "kroger", "safeway", "aldi", "walmart grocery"
    ],
    confidence: 0.92,
    reason: "english_grocery_cues"
  },
  {
    preferred: ["Restaurants"],
    broadCues: ["food", "dining", "restaurant"],
    textCues: [
      "food drinks", "food and drinks", "restaurant", "ristorante", "bistro",
      "grill", "diner", "dinner", "lunch", "steakhouse", "sushi", "ramen",
      "pizza", "black sheep", "knead hk", "ebeneezer"
    ],
    confidence: 0.9,
    reason: "english_restaurant_cues"
  },
  {
    preferred: ["Internet"],
    broadCues: ["utilities", "connectivity", "internet"],
    textCues: ["internet", "broadband", "fiber", "fibre", "wifi", "hkbn", "xfinity", "verizon fios"],
    confidence: 0.92,
    reason: "english_internet_cues"
  },
  {
    preferred: ["Phone"],
    broadCues: ["utilities", "telecom", "phone", "connectivity"],
    textCues: ["mobile", "phone", "wireless", "cellular", "singtel", "birdie", "at&t", "t mobile", "tmobile", "verizon"],
    confidence: 0.91,
    reason: "english_phone_cues"
  },
  {
    preferred: ["Electricity"],
    broadCues: ["utilities", "home", "housing"],
    textCues: ["electric", "electricity", "power bill", "utility power", "kwh"],
    confidence: 0.92,
    reason: "english_electricity_cues"
  },
  {
    preferred: ["Water"],
    broadCues: ["utilities", "home", "housing"],
    textCues: ["water bill", "water utility", "water services", "waterworks"],
    confidence: 0.92,
    reason: "english_water_cues"
  },
  {
    preferred: ["Gas & Heating"],
    broadCues: ["utilities", "home", "housing"],
    textCues: ["gas utility", "natural gas", "gas bill", "city gas"],
    confidence: 0.92,
    reason: "english_gas_utility_cues"
  },
  {
    preferred: ["Rent"],
    broadCues: ["housing", "home", "rent"],
    textCues: ["rent", "apartment rent", "tenant", "landlord", "lease"],
    confidence: 0.93,
    reason: "english_rent_cues"
  },
  {
    preferred: ["Streaming Services"],
    broadCues: ["digital", "media", "subscription", "entertainment"],
    textCues: ["spotify", "netflix", "netflicks", "disney", "hulu", "youtube premium", "apple tv", "max"],
    confidence: 0.93,
    reason: "english_streaming_cues"
  },
  {
    preferred: ["Movies & Events"],
    broadCues: ["entertainment", "movie", "cinema", "events"],
    textCues: ["movie", "cinema", "imax", "theatre", "theater", "ticketmaster", "concert", "event ticket"],
    confidence: 0.92,
    reason: "english_movies_events_cues"
  },
  {
    preferred: ["Fitness & Gym"],
    broadCues: ["health", "fitness", "wellness"],
    textCues: ["gym", "fitness", "yoga", "pilates", "planet fitness", "la fitness", "anytime fitness"],
    confidence: 0.92,
    reason: "english_fitness_cues"
  },
  {
    preferred: ["Wellness & Spa"],
    broadCues: ["health", "wellness", "self care"],
    textCues: ["spa", "massage", "wellness", "sauna"],
    confidence: 0.9,
    reason: "english_wellness_spa_cues"
  },
  {
    preferred: ["Prescriptions"],
    broadCues: ["health", "medical", "pharmacy"],
    textCues: ["pharmacy", "drugstore", "prescription", "mannings", "watsons", "walgreens", "cvs", "rite aid"],
    confidence: 0.92,
    reason: "english_pharmacy_cues"
  },
  {
    preferred: ["Dental Care"],
    broadCues: ["health", "medical", "dental"],
    textCues: ["dental", "dentist", "orthodontist"],
    confidence: 0.92,
    reason: "english_dental_cues"
  },
  {
    preferred: ["Vision Care"],
    broadCues: ["health", "medical", "vision"],
    textCues: ["optical", "vision", "glasses", "contact lenses", "optometrist"],
    confidence: 0.92,
    reason: "english_vision_cues"
  },
  {
    preferred: ["Bank Fees"],
    broadCues: ["bank", "fees", "financial"],
    textCues: ["bank fee", "monthly service fee", "maintenance fee", "overdraft fee", "atm fee"],
    confidence: 0.93,
    reason: "english_bank_fees_cues"
  },
  {
    preferred: ["Credit Card Fees"],
    broadCues: ["credit", "fees", "financial"],
    textCues: ["late fee", "annual fee", "cash advance fee", "foreign transaction fee"],
    confidence: 0.93,
    reason: "english_credit_card_fees_cues"
  },
  {
    preferred: ["Taxes"],
    broadCues: ["tax", "government", "financial"],
    textCues: ["tax", "irs", "revenue service", "tax payment"],
    confidence: 0.92,
    reason: "english_taxes_cues"
  },
  {
    preferred: ["Property Tax"],
    broadCues: ["tax", "property", "housing"],
    textCues: ["property tax", "real estate tax"],
    confidence: 0.93,
    reason: "english_property_tax_cues"
  },
  {
    preferred: ["Insurance (Other)"],
    broadCues: ["insurance", "coverage", "premium"],
    textCues: ["insurance", "premium"],
    confidence: 0.88,
    reason: "english_insurance_other_cues"
  },
  {
    preferred: ["Salary"],
    broadCues: ["income", "salary", "payroll"],
    textCues: ["payroll", "salary", "wages", "direct deposit", "employer"],
    confidence: 0.94,
    reason: "english_salary_cues"
  },
  {
    preferred: ["Bonus"],
    broadCues: ["income", "salary", "payroll"],
    textCues: ["bonus", "commission"],
    confidence: 0.93,
    reason: "english_bonus_cues"
  },
  {
    preferred: ["Interest"],
    broadCues: ["income", "interest", "savings"],
    textCues: ["interest paid", "interest earned", "intrst pymnt", "int earned"],
    confidence: 0.93,
    reason: "english_interest_income_cues"
  },
  {
    preferred: ["Dividends"],
    broadCues: ["income", "investments", "returns"],
    textCues: ["dividend", "div reinvest", "div payout"],
    confidence: 0.93,
    reason: "english_dividend_cues"
  },
  {
    preferred: ["Refund"],
    broadCues: ["income", "refund", "reversal"],
    textCues: ["refund", "reversal", "returned payment"],
    confidence: 0.92,
    reason: "english_refund_cues"
  },
  {
    preferred: ["Cashback & Rewards"],
    broadCues: ["income", "rewards", "cashback"],
    textCues: ["cashback", "reward", "points redemption", "rebate"],
    confidence: 0.93,
    reason: "english_cashback_rewards_cues"
  },
  {
    preferred: ["Tax Refund"],
    broadCues: ["income", "tax", "refund"],
    textCues: ["tax refund", "irs refund", "revenue refund"],
    confidence: 0.94,
    reason: "english_tax_refund_cues"
  },
  {
    preferred: ["Rental Income"],
    broadCues: ["income", "rent", "property"],
    textCues: ["rent received", "rental income", "tenant payment"],
    confidence: 0.94,
    reason: "english_rental_income_cues"
  },
  {
    preferred: ["Freelance", "Side Hustle", "Business"],
    broadCues: ["income", "business", "freelance", "contract"],
    textCues: ["invoice", "client payment", "freelance", "contract", "stripe payout", "square payout", "shopify payout"],
    confidence: 0.89,
    reason: "english_freelance_income_cues"
  }
,
  // Remaining MD-plan category coverage.
  { preferred: ["Travel"], broadCues: ["travel", "trip", "tour", "vacation", "visa", "passport", "luggage", "visa fee"], textCues: ["travel", "tour", "visa fee", "passport", "luggage", "travel agency", "trip", "excursion"], confidence: 0.78, reason: "md_plan_travel_english" },
  { preferred: ["Mortgage"], broadCues: ["housing", "mortgage", "home loan", "property loan", "loan", "housing loan"], textCues: ["mortgage", "home loan", "housing loan"], confidence: 0.82, reason: "md_plan_mortgage_english" },
  { preferred: ["Software & Apps"], broadCues: ["software", "app", "apps", "digital", "subscription", "software & apps", "app store", "google play", "microsoft"], textCues: ["App Store", "Google Play", "Microsoft", "Adobe", "Canva", "Notion", "Dropbox", "iCloud", "OpenAI", "ChatGPT", "Figma", "software"], confidence: 0.82, reason: "md_plan_software_apps_english" },
  { preferred: ["Games"], broadCues: ["games", "gaming", "entertainment", "game", "steam", "playstation", "xbox"], textCues: ["Steam", "PlayStation", "Xbox", "Nintendo", "Epic Games", "Roblox", "gaming"], confidence: 0.82, reason: "md_plan_games_english" },
  { preferred: ["Electronics"], broadCues: ["electronics", "tech", "device", "shopping", "retail", "apple", "best buy", "newegg"], textCues: ["Apple", "Best Buy", "Newegg", "Micro Center", "SparkFun", "electronics", "computer", "camera"], confidence: 0.82, reason: "md_plan_electronics_english" },
  { preferred: ["Clothing"], broadCues: ["clothing", "apparel", "fashion", "shopping", "retail", "zara", "h&m", "uniqlo"], textCues: ["Zara", "H&M", "Uniqlo", "Shein", "clothing", "apparel"], confidence: 0.82, reason: "md_plan_clothing_english" },
  { preferred: ["Shoes"], broadCues: ["shoes", "footwear", "sneakers", "shopping", "retail"], textCues: ["shoes", "sneakers", "footwear", "Nike", "Adidas", "Foot Locker"], confidence: 0.82, reason: "md_plan_shoes_english" },
  { preferred: ["Beauty & Cosmetics"], broadCues: ["beauty", "cosmetics", "makeup", "skincare", "shopping", "retail", "beauty & cosmetics", "sephora", "ulta"], textCues: ["Sephora", "Ulta", "cosmetics", "makeup", "beauty"], confidence: 0.82, reason: "md_plan_beauty_cosmetics_english" },
  { preferred: ["Furniture"], broadCues: ["furniture", "home", "household", "decor", "ikea", "sofa"], textCues: ["IKEA", "furniture", "sofa", "mattress", "home furnishings"], confidence: 0.82, reason: "md_plan_furniture_english" },
  { preferred: ["Home Improvement"], broadCues: ["home improvement", "hardware", "renovation", "repair", "home", "home depot", "lowe's"], textCues: ["Home Depot", "Lowe's", "hardware", "tools", "paint", "renovation"], confidence: 0.82, reason: "md_plan_home_improvement_english" },
  { preferred: ["Shopping"], broadCues: ["shopping", "retail", "store", "marketplace", "amazon", "target", "walmart"], textCues: ["Amazon", "Target", "Walmart", "eBay", "Shopee", "Lazada", "AliExpress"], confidence: 0.78, reason: "md_plan_shopping_english" },
  { preferred: ["Doctor Visits"], broadCues: ["doctor", "medical", "clinic", "health", "healthcare", "doctor visits", "medical center"], textCues: ["doctor", "clinic", "medical center", "physician", "urgent care"], confidence: 0.82, reason: "md_plan_doctor_visits_english" },
  // End remaining MD-plan category coverage.
];

const TRADITIONAL_CHINESE_SEMANTIC_RULES: SemanticRule[] = [
  {
    preferred: ["Flights"],
    broadCues: ["travel", "flight", "airline", "transport", "旅遊", "航班", "交通"],
    textCues: ["航班", "航空", "機票", "登機", "國泰", "港航", "香港快運"],
    confidence: 0.93,
    reason: "zh_hk_flights_cues"
  },
  {
    preferred: ["Hotels & Lodging"],
    broadCues: ["travel", "hotel", "lodging", "vacation", "旅遊", "住宿"],
    textCues: ["酒店", "旅館", "住宿", "民宿", "度假村"],
    confidence: 0.93,
    reason: "zh_hk_hotels_cues"
  },
  {
    preferred: ["Rideshare"],
    broadCues: ["transport", "commute", "ride", "travel", "交通"],
    textCues: ["的士", "網約車", "uber", "滴滴"],
    confidence: 0.92,
    reason: "zh_hk_rideshare_cues"
  },
  {
    preferred: ["Public Transit"],
    broadCues: ["transport", "commute", "travel", "transit", "交通"],
    textCues: ["地鐵", "巴士", "火車", "電車", "港鐵", "mtr", "八達通", "渡輪"],
    confidence: 0.92,
    reason: "zh_hk_public_transit_cues"
  },
  {
    preferred: ["Parking"],
    broadCues: ["transport", "car", "travel", "交通"],
    textCues: ["停車", "泊車", "停車場", "咪錶"],
    confidence: 0.93,
    reason: "zh_hk_parking_cues"
  },
  {
    preferred: ["Tolls"],
    broadCues: ["transport", "car", "travel", "交通"],
    textCues: ["隧道費", "路費", "收費公路", "高速費"],
    confidence: 0.93,
    reason: "zh_hk_tolls_cues"
  },
  {
    preferred: ["Gas & Fuel"],
    broadCues: ["transport", "car", "fuel", "交通"],
    textCues: ["油站", "汽油", "柴油", "加油", "esso", "shell", "caltex"],
    confidence: 0.93,
    reason: "zh_hk_gas_fuel_cues"
  },
  {
    preferred: ["Coffee & Cafes"],
    broadCues: ["food", "dining", "coffee", "cafe", "餐飲", "咖啡"],
    textCues: ["咖啡", "咖啡店", "星巴克", "太平洋咖啡"],
    confidence: 0.92,
    reason: "zh_hk_coffee_cues"
  },
  {
    preferred: ["Fast Food"],
    broadCues: ["food", "dining", "restaurant", "餐飲"],
    textCues: ["快餐", "麥當勞", "肯德基", "漢堡王", "subway"],
    confidence: 0.93,
    reason: "zh_hk_fast_food_cues"
  },
  {
    preferred: ["Food Delivery"],
    broadCues: ["food", "dining", "delivery", "餐飲", "外賣"],
    textCues: ["外賣", "送餐", "foodpanda", "deliveroo", "ubereats", "戶戶送"],
    confidence: 0.93,
    reason: "zh_hk_food_delivery_cues"
  },
  {
    preferred: ["Groceries"],
    broadCues: ["food", "household", "grocery", "日常", "超市"],
    textCues: ["超市", "雜貨", "百佳", "惠康", "market place", "citysuper"],
    confidence: 0.92,
    reason: "zh_hk_grocery_cues"
  },
  {
    preferred: ["Restaurants"],
    broadCues: ["food", "dining", "restaurant", "餐飲"],
    textCues: ["餐廳", "食肆", "飯店", "茶餐廳"],
    confidence: 0.9,
    reason: "zh_hk_restaurant_cues"
  },
  {
    preferred: ["Internet"],
    broadCues: ["utilities", "connectivity", "internet", "網絡", "上網"],
    textCues: ["寬頻", "上網", "網絡", "互聯網", "hkbn", "hgc", "netvigator"],
    confidence: 0.92,
    reason: "zh_hk_internet_cues"
  },
  {
    preferred: ["Phone"],
    broadCues: ["utilities", "telecom", "phone", "connectivity", "電訊", "手機"],
    textCues: ["手機", "電話費", "流動", "電訊", "通訊", "3hk", "csl", "smt"],
    confidence: 0.91,
    reason: "zh_hk_phone_cues"
  },
  {
    preferred: ["Electricity"],
    broadCues: ["utilities", "home", "housing", "家居", "公用事業"],
    textCues: ["電費", "電力", "中電", "港燈"],
    confidence: 0.92,
    reason: "zh_hk_electricity_cues"
  },
  {
    preferred: ["Water"],
    broadCues: ["utilities", "home", "housing", "家居", "公用事業"],
    textCues: ["水費", "水務", "食水"],
    confidence: 0.92,
    reason: "zh_hk_water_cues"
  },
  {
    preferred: ["Gas & Heating"],
    broadCues: ["utilities", "home", "housing", "家居", "公用事業"],
    textCues: ["煤氣", "石油氣", "燃氣", "煤氣費", "towngas"],
    confidence: 0.92,
    reason: "zh_hk_gas_heating_cues"
  },
  {
    preferred: ["Rent"],
    broadCues: ["housing", "home", "rent", "租屋", "住宅"],
    textCues: ["租金", "租屋", "租約", "業主"],
    confidence: 0.93,
    reason: "zh_hk_rent_cues"
  },
  {
    preferred: ["Streaming Services"],
    broadCues: ["digital", "media", "subscription", "entertainment", "串流", "娛樂"],
    textCues: ["串流", "影音平台", "netflix", "spotify", "disney+", "youtube premium"],
    confidence: 0.93,
    reason: "zh_hk_streaming_cues"
  },
  {
    preferred: ["Movies & Events"],
    broadCues: ["entertainment", "movie", "cinema", "events", "娛樂", "電影"],
    textCues: ["電影", "戲院", "門票", "演唱會", "活動票"],
    confidence: 0.92,
    reason: "zh_hk_movies_events_cues"
  },
  {
    preferred: ["Fitness & Gym"],
    broadCues: ["health", "fitness", "wellness", "健康", "健身"],
    textCues: ["健身", "健身房", "瑜伽", "普拉提", "gym"],
    confidence: 0.92,
    reason: "zh_hk_fitness_cues"
  },
  {
    preferred: ["Wellness & Spa"],
    broadCues: ["health", "wellness", "self care", "健康", "保健"],
    textCues: ["水療", "按摩", "桑拿", "養生"],
    confidence: 0.9,
    reason: "zh_hk_wellness_spa_cues"
  },
  {
    preferred: ["Prescriptions"],
    broadCues: ["health", "medical", "pharmacy", "醫療", "藥房"],
    textCues: ["藥房", "藥局", "處方", "配藥", "萬寧", "屈臣氏"],
    confidence: 0.92,
    reason: "zh_hk_prescriptions_cues"
  },
  {
    preferred: ["Dental Care"],
    broadCues: ["health", "medical", "dental", "醫療", "牙科"],
    textCues: ["牙科", "牙醫", "箍牙"],
    confidence: 0.92,
    reason: "zh_hk_dental_cues"
  },
  {
    preferred: ["Vision Care"],
    broadCues: ["health", "medical", "vision", "醫療", "視力"],
    textCues: ["眼鏡", "視光", "視力", "隱形眼鏡", "驗眼"],
    confidence: 0.92,
    reason: "zh_hk_vision_cues"
  },
  {
    preferred: ["Bank Fees"],
    broadCues: ["bank", "fees", "financial", "銀行", "費用"],
    textCues: ["手續費", "銀行費", "服務費", "透支費", "atm費"],
    confidence: 0.93,
    reason: "zh_hk_bank_fees_cues"
  },
  {
    preferred: ["Credit Card Fees"],
    broadCues: ["credit", "fees", "financial", "信用卡", "費用"],
    textCues: ["信用卡年費", "滯納金", "現金透支費", "海外交易費"],
    confidence: 0.93,
    reason: "zh_hk_credit_card_fees_cues"
  },
  {
    preferred: ["Taxes"],
    broadCues: ["tax", "government", "financial", "稅", "政府"],
    textCues: ["稅款", "交稅", "稅務局", "政府稅"],
    confidence: 0.92,
    reason: "zh_hk_taxes_cues"
  },
  {
    preferred: ["Property Tax"],
    broadCues: ["tax", "property", "housing", "物業", "稅"],
    textCues: ["物業稅", "地稅", "差餉"],
    confidence: 0.93,
    reason: "zh_hk_property_tax_cues"
  },
  {
    preferred: ["Insurance (Other)"],
    broadCues: ["insurance", "coverage", "premium", "保險"],
    textCues: ["保險", "保費", "保單"],
    confidence: 0.88,
    reason: "zh_hk_insurance_other_cues"
  },
  {
    preferred: ["Salary"],
    broadCues: ["income", "salary", "payroll", "收入", "薪金"],
    textCues: ["薪金", "工資", "出糧", "人工", "薪酬"],
    confidence: 0.94,
    reason: "zh_hk_salary_cues"
  },
  {
    preferred: ["Bonus"],
    broadCues: ["income", "salary", "payroll", "收入", "獎金"],
    textCues: ["花紅", "獎金", "佣金"],
    confidence: 0.93,
    reason: "zh_hk_bonus_cues"
  },
  {
    preferred: ["Interest"],
    broadCues: ["income", "interest", "savings", "收入", "利息"],
    textCues: ["利息", "存款利息", "利息收入"],
    confidence: 0.93,
    reason: "zh_hk_interest_income_cues"
  },
  {
    preferred: ["Dividends"],
    broadCues: ["income", "investments", "returns", "收入", "投資"],
    textCues: ["股息", "派息", "紅利"],
    confidence: 0.93,
    reason: "zh_hk_dividends_cues"
  },
  {
    preferred: ["Refund"],
    broadCues: ["income", "refund", "reversal", "退款", "收入"],
    textCues: ["退款", "退費", "回水", "交易撤銷"],
    confidence: 0.92,
    reason: "zh_hk_refund_cues"
  },
  {
    preferred: ["Cashback & Rewards"],
    broadCues: ["income", "rewards", "cashback", "回贈", "收入"],
    textCues: ["現金回贈", "回贈", "積分兌換", "返現"],
    confidence: 0.93,
    reason: "zh_hk_cashback_rewards_cues"
  },
  {
    preferred: ["Tax Refund"],
    broadCues: ["income", "tax", "refund", "退稅", "收入"],
    textCues: ["退稅", "稅務退款"],
    confidence: 0.94,
    reason: "zh_hk_tax_refund_cues"
  },
  {
    preferred: ["Rental Income"],
    broadCues: ["income", "rent", "property", "租金", "收入"],
    textCues: ["租金收入", "收租", "租客付款"],
    confidence: 0.94,
    reason: "zh_hk_rental_income_cues"
  },
  {
    preferred: ["Freelance", "Side Hustle", "Business"],
    broadCues: ["income", "business", "freelance", "contract", "收入", "生意"],
    textCues: ["自由工作", "接案", "客戶付款", "商業收入", "營業收入", "合約款"],
    confidence: 0.89,
    reason: "zh_hk_freelance_income_cues"
  }
,
  // Remaining MD-plan category coverage.
  { preferred: ["Travel"], broadCues: ["travel", "trip", "tour", "vacation", "visa", "passport", "luggage", "\u65c5\u904a", "\u65c5\u884c\u793e", "\u7c3d\u8b49"], textCues: ["\u65c5\u904a", "\u65c5\u884c\u793e", "\u7c3d\u8b49", "\u8b77\u7167", "\u884c\u674e"], confidence: 0.78, reason: "md_plan_travel_traditional_chinese" },
  { preferred: ["Mortgage"], broadCues: ["housing", "mortgage", "home loan", "property loan", "loan", "\u6309\u63ed", "\u623f\u8cb8"], textCues: ["\u6309\u63ed", "\u623f\u8cb8"], confidence: 0.82, reason: "md_plan_mortgage_traditional_chinese" },
  { preferred: ["Software & Apps"], broadCues: ["software", "app", "apps", "digital", "subscription", "software & apps", "\u61c9\u7528\u7a0b\u5f0f", "\u8edf\u4ef6", "app store"], textCues: ["\u61c9\u7528\u7a0b\u5f0f", "\u8edf\u4ef6", "App Store", "Google Play"], confidence: 0.82, reason: "md_plan_software_apps_traditional_chinese" },
  { preferred: ["Games"], broadCues: ["games", "gaming", "entertainment", "game", "\u904a\u6232", "steam", "playstation"], textCues: ["\u904a\u6232", "Steam", "PlayStation", "Nintendo"], confidence: 0.82, reason: "md_plan_games_traditional_chinese" },
  { preferred: ["Electronics"], broadCues: ["electronics", "tech", "device", "shopping", "retail", "\u96fb\u5b50", "\u96fb\u8166", "\u76f8\u6a5f"], textCues: ["\u96fb\u5b50", "\u96fb\u8166", "\u76f8\u6a5f", "Apple"], confidence: 0.82, reason: "md_plan_electronics_traditional_chinese" },
  { preferred: ["Clothing"], broadCues: ["clothing", "apparel", "fashion", "shopping", "retail", "\u670d\u88dd", "\u8863\u670d", "zara"], textCues: ["\u670d\u88dd", "\u8863\u670d", "Zara", "Uniqlo"], confidence: 0.82, reason: "md_plan_clothing_traditional_chinese" },
  { preferred: ["Shoes"], broadCues: ["shoes", "footwear", "sneakers", "shopping", "retail", "\u978b", "\u904b\u52d5\u978b", "nike"], textCues: ["\u978b", "\u904b\u52d5\u978b", "Nike", "Adidas"], confidence: 0.82, reason: "md_plan_shoes_traditional_chinese" },
  { preferred: ["Beauty & Cosmetics"], broadCues: ["beauty", "cosmetics", "makeup", "skincare", "shopping", "retail", "beauty & cosmetics", "\u5316\u599d\u54c1", "\u7f8e\u5bb9", "sephora"], textCues: ["\u5316\u599d\u54c1", "\u7f8e\u5bb9", "Sephora"], confidence: 0.82, reason: "md_plan_beauty_cosmetics_traditional_chinese" },
  { preferred: ["Furniture"], broadCues: ["furniture", "home", "household", "decor", "\u50a2\u4fec", "\u5bb6\u5177", "\u6c99\u767c"], textCues: ["\u50a2\u4fec", "\u5bb6\u5177", "\u6c99\u767c", "\u5e8a\u8925", "IKEA"], confidence: 0.82, reason: "md_plan_furniture_traditional_chinese" },
  { preferred: ["Home Improvement"], broadCues: ["home improvement", "hardware", "renovation", "repair", "home", "\u4e94\u91d1", "\u5de5\u5177", "\u6cb9\u6f06"], textCues: ["\u4e94\u91d1", "\u5de5\u5177", "\u6cb9\u6f06", "\u88dd\u4fee"], confidence: 0.82, reason: "md_plan_home_improvement_traditional_chinese" },
  { preferred: ["Shopping"], broadCues: ["shopping", "retail", "store", "marketplace", "\u8cfc\u7269", "\u7db2\u8cfc", "\u6dd8\u5bf6"], textCues: ["\u8cfc\u7269", "\u7db2\u8cfc", "\u6dd8\u5bf6", "HKTVmall"], confidence: 0.78, reason: "md_plan_shopping_traditional_chinese" },
  { preferred: ["Doctor Visits"], broadCues: ["doctor", "medical", "clinic", "health", "healthcare", "doctor visits", "\u91ab\u751f", "\u8a3a\u6240", "\u91ab\u7642\u4e2d\u5fc3"], textCues: ["\u91ab\u751f", "\u8a3a\u6240", "\u91ab\u7642\u4e2d\u5fc3"], confidence: 0.82, reason: "md_plan_doctor_visits_traditional_chinese" },
  // End remaining MD-plan category coverage.
];

const INDONESIAN_SEMANTIC_RULES: SemanticRule[] = [
  { preferred: ["Flights"], broadCues: ["travel", "transport", "flight", "airline", "penerbangan", "maskapai"], textCues: ["penerbangan", "maskapai", "tiket pesawat", "bandara", "garuda", "airasia", "lion air", "citilink"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Hotels & Lodging"], broadCues: ["travel", "lodging", "hotel", "accommodation", "penginapan"], textCues: ["hotel", "penginapan", "resor", "villa", "booking hotel", "reddoorz", "oyo"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Rideshare"], broadCues: ["transport", "taxi", "rideshare", "ojek", "taksi"], textCues: ["grab", "gojek", "gocar", "goride", "ojek", "taksi", "bluebird"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Public Transit"], broadCues: ["transport", "public transit", "commute", "angkutan umum"], textCues: ["mrt", "lrt", "krl", "transjakarta", "bus", "kereta", "angkutan umum", "kartu transportasi"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Parking"], broadCues: ["transport", "parking", "parkir"], textCues: ["parkir", "gedung parkir", "biaya parkir", "tempat parkir"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Tolls"], broadCues: ["transport", "toll", "tol"], textCues: ["tol", "jalan tol", "e toll", "etoll", "kartu tol", "gerbang tol"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Gas & Fuel"], broadCues: ["transport", "fuel", "gas", "bensin", "bbm"], textCues: ["bensin", "bbm", "solar", "pertamina", "shell", "spbu", "bahan bakar"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Coffee & Cafes"], broadCues: ["food", "coffee", "cafe", "kopi", "kafe"], textCues: ["kopi", "kafe", "cafe", "starbucks", "kopi kenangan", "janji jiwa"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Fast Food"], broadCues: ["food", "fast food", "quick service", "cepat saji"], textCues: ["cepat saji", "mcdonalds", "mcdonald", "kfc", "burger king", "wendys", "a&w"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Food Delivery"], broadCues: ["food", "delivery", "takeout", "antar makanan"], textCues: ["gofood", "grabfood", "shopeefood", "pesan antar", "antar makanan", "delivery makanan"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Groceries"], broadCues: ["food", "groceries", "supermarket", "belanja harian"], textCues: ["supermarket", "minimarket", "alfamart", "indomaret", "hypermart", "ranch market", "bahan makanan"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Restaurants"], broadCues: ["food", "restaurant", "dining", "restoran"], textCues: ["restoran", "rumah makan", "warung", "dining", "makan di tempat"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Internet"], broadCues: ["utilities", "internet", "broadband", "internet rumah"], textCues: ["internet", "wifi", "indihome", "first media", "biznet", "myrepublic", "tagihan internet"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Phone"], broadCues: ["utilities", "phone", "mobile", "pulsa"], textCues: ["pulsa", "paket data", "telkomsel", "xl", "indosat", "tri", "smartfren", "tagihan ponsel"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Electricity"], broadCues: ["utilities", "electricity", "power", "listrik"], textCues: ["listrik", "pln", "token listrik", "tagihan listrik"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Water"], broadCues: ["utilities", "water", "air"], textCues: ["pdam", "tagihan air", "rekening air", "air minum"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Gas & Heating"], broadCues: ["utilities", "gas", "heating", "elpiji"], textCues: ["gas", "elpiji", "lpg", "gas rumah", "isi ulang gas"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Rent"], broadCues: ["housing", "rent", "sewa"], textCues: ["sewa", "kontrakan", "kos", "kost", "bayar sewa", "uang sewa", "pemilik kos"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Streaming Services"], broadCues: ["entertainment", "streaming", "subscription", "layanan streaming"], textCues: ["netflix", "spotify", "vidio", "disney hotstar", "streaming", "langganan musik"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Movies & Events"], broadCues: ["entertainment", "movies", "events", "bioskop"], textCues: ["bioskop", "cinema", "tiket nonton", "konser", "event", "loket"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Fitness & Gym"], broadCues: ["health", "fitness", "gym", "pusat kebugaran"], textCues: ["gym", "fitness", "yoga", "pusat kebugaran", "membership gym"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Wellness & Spa"], broadCues: ["health", "wellness", "spa", "pijat"], textCues: ["spa", "pijat", "refleksi", "sauna", "wellness"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Prescriptions"], broadCues: ["health", "pharmacy", "medicine", "apotek", "obat"], textCues: ["apotek", "obat", "resep", "kimia farma", "guardian", "century healthcare"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Dental Care"], broadCues: ["health", "dental", "dokter gigi"], textCues: ["dokter gigi", "klinik gigi", "perawatan gigi", "behel", "scaling gigi"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Vision Care"], broadCues: ["health", "vision", "optical", "optik"], textCues: ["optik", "kacamata", "lensa kontak", "periksa mata", "optical"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Bank Fees"], broadCues: ["fees", "bank fee", "service charge", "biaya bank"], textCues: ["biaya admin", "biaya bank", "biaya layanan", "biaya atm", "administrasi bank"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Credit Card Fees"], broadCues: ["fees", "credit card fee", "late fee", "biaya kartu kredit"], textCues: ["iuran tahunan", "denda keterlambatan", "biaya kartu kredit", "late fee kartu kredit"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Taxes"], broadCues: ["tax", "taxes", "pajak"], textCues: ["pajak", "ditjen pajak", "pembayaran pajak", "setoran pajak", "npwp"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Property Tax"], broadCues: ["tax", "property tax", "pbb"], textCues: ["pbb", "pajak bumi bangunan", "pajak properti", "pajak rumah"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Insurance (Other)"], broadCues: ["insurance", "premium", "asuransi"], textCues: ["asuransi", "premi", "polis", "premi asuransi"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Salary"], broadCues: ["income", "salary", "payroll", "gaji"], textCues: ["gaji", "upah", "payroll", "slip gaji", "pembayaran gaji"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Bonus"], broadCues: ["income", "bonus", "commission", "bonus"], textCues: ["bonus", "komisi", "insentif", "tunjangan kinerja"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Interest"], broadCues: ["income", "interest", "bunga"], textCues: ["bunga tabungan", "pendapatan bunga", "bunga deposito", "interest income"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Dividends"], broadCues: ["income", "dividend", "dividen"], textCues: ["dividen", "pembagian dividen", "dividend payment"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Refund"], broadCues: ["income", "refund", "reversal", "pengembalian dana"], textCues: ["refund", "pengembalian dana", "pembalikan transaksi", "dana kembali"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Cashback & Rewards"], broadCues: ["income", "cashback", "rewards", "cashback", "reward"], textCues: ["cashback", "reward", "poin", "rebate", "hadiah kartu"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Tax Refund"], broadCues: ["income", "tax refund", "restitusi pajak"], textCues: ["restitusi pajak", "pengembalian pajak", "tax refund"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Rental Income"], broadCues: ["income", "rental income", "pendapatan sewa"], textCues: ["pendapatan sewa", "terima sewa", "pembayaran penyewa", "uang sewa masuk"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Freelance", "Side Hustle", "Business"], broadCues: ["income", "freelance", "client payment", "income", "side hustle", "business income", "usaha sampingan"], textCues: ["freelance", "invoice", "pembayaran klien", "kontrak", "usaha sampingan", "penghasilan sampingan", "pendapatan usaha", "pemasukan bisnis", "penjualan"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },

  // Remaining MD-plan category coverage.
  { preferred: ["Travel"], broadCues: ["travel", "trip", "tour", "vacation", "visa", "passport", "luggage", "perjalanan", "wisata", "tur"], textCues: ["perjalanan", "wisata", "tur", "visa", "paspor", "bagasi"], confidence: 0.78, reason: "md_plan_travel_indonesian" },
  { preferred: ["Mortgage"], broadCues: ["housing", "mortgage", "home loan", "property loan", "loan", "kpr", "kredit rumah"], textCues: ["KPR", "kredit rumah"], confidence: 0.82, reason: "md_plan_mortgage_indonesian" },
  { preferred: ["Software & Apps"], broadCues: ["software", "app", "apps", "digital", "subscription", "software & apps", "aplikasi", "perangkat lunak", "google play"], textCues: ["aplikasi", "perangkat lunak", "Google Play", "App Store"], confidence: 0.82, reason: "md_plan_software_apps_indonesian" },
  { preferred: ["Games"], broadCues: ["games", "gaming", "entertainment", "game", "permainan", "steam"], textCues: ["game", "permainan", "Steam", "PlayStation"], confidence: 0.82, reason: "md_plan_games_indonesian" },
  { preferred: ["Electronics"], broadCues: ["electronics", "tech", "device", "shopping", "retail", "elektronik", "komputer", "kamera"], textCues: ["elektronik", "komputer", "kamera", "Apple"], confidence: 0.82, reason: "md_plan_electronics_indonesian" },
  { preferred: ["Clothing"], broadCues: ["clothing", "apparel", "fashion", "shopping", "retail", "pakaian", "baju", "uniqlo"], textCues: ["pakaian", "baju", "Uniqlo", "Zara"], confidence: 0.82, reason: "md_plan_clothing_indonesian" },
  { preferred: ["Shoes"], broadCues: ["shoes", "footwear", "sneakers", "shopping", "retail", "sepatu", "nike"], textCues: ["sepatu", "sneakers", "Nike", "Adidas"], confidence: 0.82, reason: "md_plan_shoes_indonesian" },
  { preferred: ["Beauty & Cosmetics"], broadCues: ["beauty", "cosmetics", "makeup", "skincare", "shopping", "retail", "beauty & cosmetics", "kosmetik", "kecantikan"], textCues: ["kosmetik", "makeup", "kecantikan"], confidence: 0.82, reason: "md_plan_beauty_cosmetics_indonesian" },
  { preferred: ["Furniture"], broadCues: ["furniture", "home", "household", "decor", "furnitur", "mebel", "sofa"], textCues: ["furnitur", "mebel", "sofa", "kasur", "IKEA"], confidence: 0.82, reason: "md_plan_furniture_indonesian" },
  { preferred: ["Home Improvement"], broadCues: ["home improvement", "hardware", "renovation", "repair", "home", "toko bangunan", "perkakas", "cat"], textCues: ["toko bangunan", "perkakas", "cat", "renovasi"], confidence: 0.82, reason: "md_plan_home_improvement_indonesian" },
  { preferred: ["Shopping"], broadCues: ["shopping", "retail", "store", "marketplace", "belanja", "shopee", "tokopedia"], textCues: ["belanja", "Shopee", "Tokopedia", "Lazada", "Bukalapak"], confidence: 0.78, reason: "md_plan_shopping_indonesian" },
  { preferred: ["Doctor Visits"], broadCues: ["doctor", "medical", "clinic", "health", "healthcare", "doctor visits", "dokter", "klinik", "pusat medis"], textCues: ["dokter", "klinik", "pusat medis"], confidence: 0.82, reason: "md_plan_doctor_visits_indonesian" },
  // End remaining MD-plan category coverage.
];

const VIETNAMESE_SEMANTIC_RULES: SemanticRule[] = [
  { preferred: ["Flights"], broadCues: ["travel", "transport", "flight", "airline", "chuyen bay", "hang khong"], textCues: ["chuyen bay", "ve may bay", "hang khong", "san bay", "vietnam airlines", "vietjet", "bamboo airways"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Hotels & Lodging"], broadCues: ["travel", "lodging", "hotel", "accommodation", "khach san"], textCues: ["khach san", "nha nghi", "resort", "dat phong", "luu tru"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Rideshare"], broadCues: ["transport", "taxi", "rideshare", "taxi", "xe om"], textCues: ["grab", "be", "gojek", "taxi", "xe om", "dat xe"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Public Transit"], broadCues: ["transport", "public transit", "commute", "xe buyt"], textCues: ["metro", "xe buyt", "tau", "tau dien", "ve xe", "giao thong cong cong"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Parking"], broadCues: ["transport", "parking", "gui xe"], textCues: ["gui xe", "phi gui xe", "bai do xe", "giu xe"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Tolls"], broadCues: ["transport", "toll", "phi cau duong"], textCues: ["phi cau duong", "tram thu phi", "ve duong bo", "etc toll"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Gas & Fuel"], broadCues: ["transport", "fuel", "gas", "xang"], textCues: ["xang", "dau diesel", "nhien lieu", "petrolimex", "cay xang"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Coffee & Cafes"], broadCues: ["food", "coffee", "cafe", "ca phe"], textCues: ["ca phe", "cafe", "highlands coffee", "phuc long", "starbucks"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Fast Food"], broadCues: ["food", "fast food", "quick service", "do an nhanh"], textCues: ["do an nhanh", "mcdonalds", "kfc", "lotteria", "burger king"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Food Delivery"], broadCues: ["food", "delivery", "takeout", "giao do an"], textCues: ["giao do an", "grabfood", "shopeefood", "baemin", "dat mon", "ship do an"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Groceries"], broadCues: ["food", "groceries", "supermarket", "sieu thi"], textCues: ["sieu thi", "cua hang tien loi", "bach hoa xanh", "winmart", "coopmart", "tap hoa"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Restaurants"], broadCues: ["food", "restaurant", "dining", "nha hang"], textCues: ["nha hang", "quan an", "bua an", "dining"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Internet"], broadCues: ["utilities", "internet", "broadband", "internet"], textCues: ["internet", "wifi", "fpt telecom", "viettel internet", "vnpt", "hoa don internet"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Phone"], broadCues: ["utilities", "phone", "mobile", "dien thoai"], textCues: ["dien thoai", "goi cuoc", "nap tien", "data di dong", "viettel", "mobifone", "vinaphone"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Electricity"], broadCues: ["utilities", "electricity", "power", "dien"], textCues: ["dien", "evn", "hoa don dien", "tien dien"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Water"], broadCues: ["utilities", "water", "nuoc"], textCues: ["nuoc", "hoa don nuoc", "tien nuoc", "cap nuoc"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Gas & Heating"], broadCues: ["utilities", "gas", "heating", "gas"], textCues: ["gas", "khi dot", "binh gas", "doi gas"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Rent"], broadCues: ["housing", "rent", "tien thue nha"], textCues: ["tien thue nha", "thue nha", "tien phong", "chu nha", "thue can ho"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Streaming Services"], broadCues: ["entertainment", "streaming", "subscription", "streaming"], textCues: ["netflix", "spotify", "fpt play", "vieon", "zing mp3", "streaming"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Movies & Events"], broadCues: ["entertainment", "movies", "events", "rap phim"], textCues: ["rap phim", "ve xem phim", "cgv", "lotte cinema", "concert", "su kien"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Fitness & Gym"], broadCues: ["health", "fitness", "gym", "phong gym"], textCues: ["phong gym", "gym", "fitness", "yoga", "hoi vien gym"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Wellness & Spa"], broadCues: ["health", "wellness", "spa", "spa"], textCues: ["spa", "massage", "xong hoi", "cham soc suc khoe"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Prescriptions"], broadCues: ["health", "pharmacy", "medicine", "nha thuoc"], textCues: ["nha thuoc", "thuoc", "don thuoc", "pharmacity", "long chau", "ankhang"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Dental Care"], broadCues: ["health", "dental", "nha khoa"], textCues: ["nha khoa", "rang", "kham rang", "tay trang rang", "nieng rang"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Vision Care"], broadCues: ["health", "vision", "optical", "kinh mat"], textCues: ["kinh mat", "optical", "mat kinh", "thi luc", "kinh ap trong"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Bank Fees"], broadCues: ["fees", "bank fee", "service charge", "phi ngan hang"], textCues: ["phi ngan hang", "phi dich vu", "phi atm", "phi chuyen khoan", "phi duy tri"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Credit Card Fees"], broadCues: ["fees", "credit card fee", "late fee", "phi the tin dung"], textCues: ["phi the tin dung", "phi thuong nien", "phi tra cham", "lai phat cham tra"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Taxes"], broadCues: ["tax", "taxes", "thue"], textCues: ["thue", "nop thue", "tong cuc thue", "ma so thue"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Property Tax"], broadCues: ["tax", "property tax", "thue bat dong san"], textCues: ["thue bat dong san", "thue nha dat", "thue tai san"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Insurance (Other)"], broadCues: ["insurance", "premium", "bao hiem"], textCues: ["bao hiem", "phi bao hiem", "hop dong bao hiem", "premium"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Salary"], broadCues: ["income", "salary", "payroll", "luong"], textCues: ["luong", "tien luong", "payroll", "tra luong"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Bonus"], broadCues: ["income", "bonus", "commission", "thuong"], textCues: ["thuong", "hoa hong", "bonus", "thuong doanh so"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Interest"], broadCues: ["income", "interest", "lai tien gui"], textCues: ["lai tien gui", "tien lai", "thu nhap lai", "lai ngan hang"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Dividends"], broadCues: ["income", "dividend", "co tuc"], textCues: ["co tuc", "chi tra co tuc", "dividend"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Refund"], broadCues: ["income", "refund", "reversal", "hoan tien"], textCues: ["hoan tien", "hoan tra", "refund", "giao dich dao nguoc"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Cashback & Rewards"], broadCues: ["income", "cashback", "rewards", "cashback"], textCues: ["cashback", "hoan tien the", "diem thuong", "phan thuong", "rebate"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Tax Refund"], broadCues: ["income", "tax refund", "hoan thue"], textCues: ["hoan thue", "hoan tien thue", "tax refund"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Rental Income"], broadCues: ["income", "rental income", "thu nhap cho thue"], textCues: ["thu nhap cho thue", "tien thue nhan", "khach thue tra tien"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Freelance", "Side Hustle", "Business"], broadCues: ["income", "freelance", "client payment", "income", "side hustle", "business income", "viec phu"], textCues: ["freelance", "hoa don", "khach hang thanh toan", "hop dong", "viec phu", "thu nhap phu", "thu nhap kinh doanh", "ban hang"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },

  // Remaining MD-plan category coverage.
  { preferred: ["Travel"], broadCues: ["travel", "trip", "tour", "vacation", "visa", "passport", "luggage", "du l\u1ecbch"], textCues: ["du l\u1ecbch", "tour", "visa", "h\u1ed9 chi\u1ebfu", "h\u00e0nh l\u00fd"], confidence: 0.78, reason: "md_plan_travel_vietnamese" },
  { preferred: ["Mortgage"], broadCues: ["housing", "mortgage", "home loan", "property loan", "loan", "th\u1ebf ch\u1ea5p", "vay mua nh\u00e0"], textCues: ["th\u1ebf ch\u1ea5p", "vay mua nh\u00e0"], confidence: 0.82, reason: "md_plan_mortgage_vietnamese" },
  { preferred: ["Software & Apps"], broadCues: ["software", "app", "apps", "digital", "subscription", "software & apps", "\u1ee9ng d\u1ee5ng", "ph\u1ea7n m\u1ec1m", "google play"], textCues: ["\u1ee9ng d\u1ee5ng", "ph\u1ea7n m\u1ec1m", "Google Play", "App Store"], confidence: 0.82, reason: "md_plan_software_apps_vietnamese" },
  { preferred: ["Games"], broadCues: ["games", "gaming", "entertainment", "game", "tr\u00f2 ch\u01a1i", "steam"], textCues: ["game", "tr\u00f2 ch\u01a1i", "Steam", "PlayStation"], confidence: 0.82, reason: "md_plan_games_vietnamese" },
  { preferred: ["Electronics"], broadCues: ["electronics", "tech", "device", "shopping", "retail", "\u0111i\u1ec7n t\u1eed", "m\u00e1y t\u00ednh", "m\u00e1y \u1ea3nh"], textCues: ["\u0111i\u1ec7n t\u1eed", "m\u00e1y t\u00ednh", "m\u00e1y \u1ea3nh", "Apple"], confidence: 0.82, reason: "md_plan_electronics_vietnamese" },
  { preferred: ["Clothing"], broadCues: ["clothing", "apparel", "fashion", "shopping", "retail", "qu\u1ea7n \u00e1o", "th\u1eddi trang", "uniqlo"], textCues: ["qu\u1ea7n \u00e1o", "th\u1eddi trang", "Uniqlo", "Zara"], confidence: 0.82, reason: "md_plan_clothing_vietnamese" },
  { preferred: ["Shoes"], broadCues: ["shoes", "footwear", "sneakers", "shopping", "retail", "gi\u00e0y", "gi\u00e0y th\u1ec3 thao", "nike"], textCues: ["gi\u00e0y", "gi\u00e0y th\u1ec3 thao", "Nike", "Adidas"], confidence: 0.82, reason: "md_plan_shoes_vietnamese" },
  { preferred: ["Beauty & Cosmetics"], broadCues: ["beauty", "cosmetics", "makeup", "skincare", "shopping", "retail", "beauty & cosmetics", "m\u1ef9 ph\u1ea9m", "trang \u0111i\u1ec3m", "l\u00e0m \u0111\u1eb9p"], textCues: ["m\u1ef9 ph\u1ea9m", "trang \u0111i\u1ec3m", "l\u00e0m \u0111\u1eb9p"], confidence: 0.82, reason: "md_plan_beauty_cosmetics_vietnamese" },
  { preferred: ["Furniture"], broadCues: ["furniture", "home", "household", "decor", "n\u1ed9i th\u1ea5t", "gh\u1ebf sofa", "n\u1ec7m"], textCues: ["n\u1ed9i th\u1ea5t", "gh\u1ebf sofa", "n\u1ec7m", "IKEA"], confidence: 0.82, reason: "md_plan_furniture_vietnamese" },
  { preferred: ["Home Improvement"], broadCues: ["home improvement", "hardware", "renovation", "repair", "home", "v\u1eadt li\u1ec7u x\u00e2y d\u1ef1ng", "d\u1ee5ng c\u1ee5", "s\u01a1n"], textCues: ["v\u1eadt li\u1ec7u x\u00e2y d\u1ef1ng", "d\u1ee5ng c\u1ee5", "s\u01a1n", "s\u1eeda nh\u00e0"], confidence: 0.82, reason: "md_plan_home_improvement_vietnamese" },
  { preferred: ["Shopping"], broadCues: ["shopping", "retail", "store", "marketplace", "mua s\u1eafm", "shopee", "lazada"], textCues: ["mua s\u1eafm", "Shopee", "Lazada", "Tiki"], confidence: 0.78, reason: "md_plan_shopping_vietnamese" },
  { preferred: ["Doctor Visits"], broadCues: ["doctor", "medical", "clinic", "health", "healthcare", "doctor visits", "b\u00e1c s\u0129", "ph\u00f2ng kh\u00e1m", "trung t\u00e2m y t\u1ebf"], textCues: ["b\u00e1c s\u0129", "ph\u00f2ng kh\u00e1m", "trung t\u00e2m y t\u1ebf"], confidence: 0.82, reason: "md_plan_doctor_visits_vietnamese" },
  // End remaining MD-plan category coverage.
];

const MALAY_SEMANTIC_RULES: SemanticRule[] = [
  { preferred: ["Flights"], broadCues: ["travel", "transport", "flight", "airline", "penerbangan"], textCues: ["penerbangan", "syarikat penerbangan", "tiket kapal terbang", "lapangan terbang", "airasia", "malaysia airlines"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Hotels & Lodging"], broadCues: ["travel", "lodging", "hotel", "accommodation", "penginapan"], textCues: ["hotel", "penginapan", "resort", "homestay", "tempahan bilik"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Rideshare"], broadCues: ["transport", "taxi", "rideshare", "teksi"], textCues: ["grab", "teksi", "mycar", "ehailing", "kereta sewa pemandu"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Public Transit"], broadCues: ["transport", "public transit", "commute", "pengangkutan awam"], textCues: ["mrt", "lrt", "bas", "ktm", "monorel", "touch n go", "pengangkutan awam"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Parking"], broadCues: ["transport", "parking", "tempat letak kereta"], textCues: ["parkir", "parking", "tempat letak kereta", "bayaran parkir"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Tolls"], broadCues: ["transport", "toll", "tol"], textCues: ["tol", "lebuhraya", "touch n go toll", "smarttag", "rfid toll"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Gas & Fuel"], broadCues: ["transport", "fuel", "gas", "petrol"], textCues: ["petrol", "diesel", "minyak", "petronas", "shell", "bhp", "stesen minyak"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Coffee & Cafes"], broadCues: ["food", "coffee", "cafe", "kopi"], textCues: ["kopi", "kafe", "cafe", "starbucks", "coffee bean", "zus coffee"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Fast Food"], broadCues: ["food", "fast food", "quick service", "makanan segera"], textCues: ["makanan segera", "mcdonalds", "kfc", "burger king", "texas chicken"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Food Delivery"], broadCues: ["food", "delivery", "takeout", "penghantaran makanan"], textCues: ["foodpanda", "grabfood", "penghantaran makanan", "hantar makanan", "pesanan makanan"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Groceries"], broadCues: ["food", "groceries", "supermarket", "barang dapur"], textCues: ["pasar raya", "supermarket", "lotus", "giant", "jaya grocer", "barang dapur", "kedai runcit"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Restaurants"], broadCues: ["food", "restaurant", "dining", "restoran"], textCues: ["restoran", "kedai makan", "mamak", "makan luar", "dining"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Internet"], broadCues: ["utilities", "internet", "broadband", "internet"], textCues: ["internet", "wifi", "unifi", "maxis fibre", "time internet", "bil internet"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Phone"], broadCues: ["utilities", "phone", "mobile", "telefon"], textCues: ["telefon", "bil telefon", "data mudah alih", "prepaid", "celcom", "digi", "maxis", "umobile"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Electricity"], broadCues: ["utilities", "electricity", "power", "elektrik"], textCues: ["elektrik", "tnb", "bil elektrik", "bayaran elektrik"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Water"], broadCues: ["utilities", "water", "air"], textCues: ["bil air", "air selangor", "bayaran air", "bekalan air"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Gas & Heating"], broadCues: ["utilities", "gas", "heating", "gas"], textCues: ["gas", "lpg", "tong gas", "gas memasak"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Rent"], broadCues: ["housing", "rent", "sewa"], textCues: ["sewa", "rumah sewa", "bayar sewa", "tuan rumah", "deposit sewa"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Streaming Services"], broadCues: ["entertainment", "streaming", "subscription", "penstriman"], textCues: ["netflix", "spotify", "astro go", "viu", "disney hotstar", "penstriman"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Movies & Events"], broadCues: ["entertainment", "movies", "events", "pawagam"], textCues: ["pawagam", "cinema", "tiket wayang", "konsert", "acara", "tiket event"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Fitness & Gym"], broadCues: ["health", "fitness", "gym", "gim"], textCues: ["gim", "gym", "fitness", "yoga", "keahlian gim"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Wellness & Spa"], broadCues: ["health", "wellness", "spa", "urut"], textCues: ["spa", "urut", "refleksologi", "sauna", "wellness"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Prescriptions"], broadCues: ["health", "pharmacy", "medicine", "farmasi"], textCues: ["farmasi", "ubat", "preskripsi", "guardian", "watsons", "ubat klinik"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Dental Care"], broadCues: ["health", "dental", "doktor gigi"], textCues: ["doktor gigi", "klinik gigi", "rawatan gigi", "pendakap gigi"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Vision Care"], broadCues: ["health", "vision", "optical", "optik"], textCues: ["optik", "cermin mata", "kanta lekap", "pemeriksaan mata", "optical"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Bank Fees"], broadCues: ["fees", "bank fee", "service charge", "caj bank"], textCues: ["caj bank", "yuran bank", "caj perkhidmatan", "caj atm", "fi bank"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Credit Card Fees"], broadCues: ["fees", "credit card fee", "late fee", "caj kad kredit"], textCues: ["yuran tahunan", "caj lewat bayar", "caj kad kredit", "fi kad kredit"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Taxes"], broadCues: ["tax", "taxes", "cukai"], textCues: ["cukai", "lhdn", "bayaran cukai", "hasil", "nombor cukai"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Property Tax"], broadCues: ["tax", "property tax", "cukai tanah"], textCues: ["cukai tanah", "cukai pintu", "cukai hartanah", "assessment tax"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Insurance (Other)"], broadCues: ["insurance", "premium", "insurans"], textCues: ["insurans", "premium", "polisi", "premium insurans"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Salary"], broadCues: ["income", "salary", "payroll", "gaji"], textCues: ["gaji", "upah", "payroll", "bayaran gaji"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Bonus"], broadCues: ["income", "bonus", "commission", "bonus"], textCues: ["bonus", "komisen", "insentif", "elaun prestasi"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Interest"], broadCues: ["income", "interest", "faedah"], textCues: ["faedah simpanan", "pendapatan faedah", "faedah deposit", "interest income"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Dividends"], broadCues: ["income", "dividend", "dividen"], textCues: ["dividen", "bayaran dividen", "pembahagian dividen"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Refund"], broadCues: ["income", "refund", "reversal", "bayaran balik"], textCues: ["refund", "bayaran balik", "pemulangan wang", "transaksi dibalikkan"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Cashback & Rewards"], broadCues: ["income", "cashback", "rewards", "pulangan tunai"], textCues: ["cashback", "pulangan tunai", "ganjaran", "mata ganjaran", "rebate"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Tax Refund"], broadCues: ["income", "tax refund", "bayaran balik cukai"], textCues: ["bayaran balik cukai", "refund cukai", "tax refund"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Rental Income"], broadCues: ["income", "rental income", "pendapatan sewa"], textCues: ["pendapatan sewa", "terima sewa", "bayaran penyewa", "sewa masuk"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Freelance", "Side Hustle", "Business"], broadCues: ["income", "freelance", "client payment", "income", "side hustle", "business income", "kerja sampingan"], textCues: ["freelance", "invois", "bayaran klien", "kontrak", "kerja sampingan", "pendapatan sampingan", "pendapatan perniagaan", "jualan"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },

  // Remaining MD-plan category coverage.
  { preferred: ["Travel"], broadCues: ["travel", "trip", "tour", "vacation", "visa", "passport", "luggage", "perjalanan", "pelancongan", "lawatan"], textCues: ["perjalanan", "pelancongan", "lawatan", "visa", "pasport", "bagasi"], confidence: 0.78, reason: "md_plan_travel_malay" },
  { preferred: ["Mortgage"], broadCues: ["housing", "mortgage", "home loan", "property loan", "loan", "gadai janji", "pinjaman perumahan"], textCues: ["gadai janji", "pinjaman perumahan"], confidence: 0.82, reason: "md_plan_mortgage_malay" },
  { preferred: ["Software & Apps"], broadCues: ["software", "app", "apps", "digital", "subscription", "software & apps", "aplikasi", "perisian", "google play"], textCues: ["aplikasi", "perisian", "Google Play", "App Store"], confidence: 0.82, reason: "md_plan_software_apps_malay" },
  { preferred: ["Games"], broadCues: ["games", "gaming", "entertainment", "game", "permainan", "steam"], textCues: ["permainan", "game", "Steam", "PlayStation"], confidence: 0.82, reason: "md_plan_games_malay" },
  { preferred: ["Electronics"], broadCues: ["electronics", "tech", "device", "shopping", "retail", "elektronik", "komputer", "kamera"], textCues: ["elektronik", "komputer", "kamera", "Apple"], confidence: 0.82, reason: "md_plan_electronics_malay" },
  { preferred: ["Clothing"], broadCues: ["clothing", "apparel", "fashion", "shopping", "retail", "pakaian", "baju", "fesyen"], textCues: ["pakaian", "baju", "fesyen", "Uniqlo"], confidence: 0.82, reason: "md_plan_clothing_malay" },
  { preferred: ["Shoes"], broadCues: ["shoes", "footwear", "sneakers", "shopping", "retail", "kasut", "nike"], textCues: ["kasut", "sneakers", "Nike", "Adidas"], confidence: 0.82, reason: "md_plan_shoes_malay" },
  { preferred: ["Beauty & Cosmetics"], broadCues: ["beauty", "cosmetics", "makeup", "skincare", "shopping", "retail", "beauty & cosmetics", "kosmetik", "solekan", "kecantikan"], textCues: ["kosmetik", "solekan", "kecantikan"], confidence: 0.82, reason: "md_plan_beauty_cosmetics_malay" },
  { preferred: ["Furniture"], broadCues: ["furniture", "home", "household", "decor", "perabot", "sofa", "tilam"], textCues: ["perabot", "sofa", "tilam", "IKEA"], confidence: 0.82, reason: "md_plan_furniture_malay" },
  { preferred: ["Home Improvement"], broadCues: ["home improvement", "hardware", "renovation", "repair", "home", "perkakasan", "alat", "cat"], textCues: ["perkakasan", "alat", "cat", "renovasi"], confidence: 0.82, reason: "md_plan_home_improvement_malay" },
  { preferred: ["Shopping"], broadCues: ["shopping", "retail", "store", "marketplace", "beli-belah", "shopee", "lazada"], textCues: ["beli-belah", "Shopee", "Lazada"], confidence: 0.78, reason: "md_plan_shopping_malay" },
  { preferred: ["Doctor Visits"], broadCues: ["doctor", "medical", "clinic", "health", "healthcare", "doctor visits", "doktor", "klinik", "pusat perubatan"], textCues: ["doktor", "klinik", "pusat perubatan"], confidence: 0.82, reason: "md_plan_doctor_visits_malay" },
  // End remaining MD-plan category coverage.
];

const FILIPINO_SEMANTIC_RULES: SemanticRule[] = [
  { preferred: ["Flights"], broadCues: ["travel", "transport", "flight", "airline", "eroplano"], textCues: ["flight", "eroplano", "airline", "ticket sa eroplano", "pal", "philippine airlines", "cebu pacific", "airport"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Hotels & Lodging"], broadCues: ["travel", "lodging", "hotel", "accommodation", "tuluyan"], textCues: ["hotel", "tuluyan", "resort", "inn", "booking ng hotel", "accommodation"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Rideshare"], broadCues: ["transport", "taxi", "rideshare", "taxi"], textCues: ["grab", "taxi", "angkas", "joyride", "ride hailing", "sakay"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Public Transit"], broadCues: ["transport", "public transit", "commute", "pampublikong transportasyon"], textCues: ["bus", "tren", "lrt", "mrt", "jeep", "beep card", "pampublikong transportasyon"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Parking"], broadCues: ["transport", "parking", "paradahan"], textCues: ["parking", "paradahan", "bayad sa parking", "garahe"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Tolls"], broadCues: ["transport", "toll", "toll"], textCues: ["toll", "nlex", "slex", "skyway", "rfid", "easytrip", "autosweep"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Gas & Fuel"], broadCues: ["transport", "fuel", "gas", "gasolina"], textCues: ["gasolina", "diesel", "fuel", "petron", "shell", "caltex", "gas station"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Coffee & Cafes"], broadCues: ["food", "coffee", "cafe", "kape"], textCues: ["kape", "cafe", "starbucks", "coffee bean", "bo coffee"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Fast Food"], broadCues: ["food", "fast food", "quick service", "fast food"], textCues: ["fast food", "jollibee", "mcdonalds", "kfc", "chowking", "burger king"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Food Delivery"], broadCues: ["food", "delivery", "takeout", "food delivery"], textCues: ["food delivery", "grabfood", "foodpanda", "padala ng pagkain", "delivery ng pagkain"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Groceries"], broadCues: ["food", "groceries", "supermarket", "grocery"], textCues: ["grocery", "supermarket", "sm supermarket", "puregold", "robinsons supermarket", "palengke"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Restaurants"], broadCues: ["food", "restaurant", "dining", "kainan"], textCues: ["restaurant", "restawran", "kainan", "karinderya", "dining"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Internet"], broadCues: ["utilities", "internet", "broadband", "internet"], textCues: ["internet", "wifi", "pldt", "converge", "sky fiber", "bayad sa internet"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Phone"], broadCues: ["utilities", "phone", "mobile", "load"], textCues: ["phone", "load", "data", "globe", "smart", "dito", "prepaid load", "mobile data"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Electricity"], broadCues: ["utilities", "electricity", "power", "kuryente"], textCues: ["kuryente", "meralco", "bill sa kuryente", "bayad kuryente"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Water"], broadCues: ["utilities", "water", "tubig"], textCues: ["tubig", "maynilad", "manila water", "bill sa tubig", "bayad tubig"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Gas & Heating"], broadCues: ["utilities", "gas", "heating", "lpg"], textCues: ["gas", "lpg", "gasul", "tangke ng gas", "cooking gas"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Rent"], broadCues: ["housing", "rent", "upa"], textCues: ["upa", "rent", "bayad upa", "landlord", "apartment rent"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Streaming Services"], broadCues: ["entertainment", "streaming", "subscription", "streaming"], textCues: ["netflix", "spotify", "disney plus", "vivamax", "streaming", "subscription"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Movies & Events"], broadCues: ["entertainment", "movies", "events", "sine"], textCues: ["sine", "movie", "ticket", "concert", "event", "sm cinema"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Fitness & Gym"], broadCues: ["health", "fitness", "gym", "gym"], textCues: ["gym", "fitness", "yoga", "membership sa gym", "workout"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Wellness & Spa"], broadCues: ["health", "wellness", "spa", "masahe"], textCues: ["spa", "masahe", "massage", "wellness", "salon spa"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Prescriptions"], broadCues: ["health", "pharmacy", "medicine", "botika"], textCues: ["botika", "gamot", "reseta", "mercury drug", "watsons pharmacy", "prescription"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Dental Care"], broadCues: ["health", "dental", "dentista"], textCues: ["dentista", "dental", "ngipin", "clinic ng ngipin", "braces"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Vision Care"], broadCues: ["health", "vision", "optical", "salamin"], textCues: ["salamin", "optical", "contact lens", "eye checkup", "vision care"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Bank Fees"], broadCues: ["fees", "bank fee", "service charge", "bayad sa bangko"], textCues: ["bank fee", "bayad sa bangko", "service fee", "atm fee", "maintenance fee"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Credit Card Fees"], broadCues: ["fees", "credit card fee", "late fee", "credit card fee"], textCues: ["late fee", "annual fee", "credit card fee", "bayad sa credit card", "penalty fee"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Taxes"], broadCues: ["tax", "taxes", "buwis"], textCues: ["buwis", "tax", "bir", "bayad buwis", "tax payment"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Property Tax"], broadCues: ["tax", "property tax", "amilyar"], textCues: ["amilyar", "property tax", "real property tax", "buwis sa lupa"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Insurance (Other)"], broadCues: ["insurance", "premium", "seguro"], textCues: ["insurance", "seguro", "premium", "policy", "bayad seguro"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Salary"], broadCues: ["income", "salary", "payroll", "suweldo"], textCues: ["suweldo", "sweldo", "salary", "payroll", "sahod"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Bonus"], broadCues: ["income", "bonus", "commission", "bonus"], textCues: ["bonus", "komisyon", "commission", "incentive", "performance bonus"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Interest"], broadCues: ["income", "interest", "interes"], textCues: ["interest income", "interes", "tubo", "bank interest", "kita sa interes"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Dividends"], broadCues: ["income", "dividend", "dibidendo"], textCues: ["dividend", "dibidendo", "bayad dibidendo", "dividend payment"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Refund"], broadCues: ["income", "refund", "reversal", "balik bayad"], textCues: ["refund", "balik bayad", "reversal", "ibinalik na bayad", "money back"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Cashback & Rewards"], broadCues: ["income", "cashback", "rewards", "cashback"], textCues: ["cashback", "reward", "rebate", "points", "gantimpala"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Tax Refund"], broadCues: ["income", "tax refund", "refund sa buwis"], textCues: ["tax refund", "refund sa buwis", "ibinalik na buwis"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Rental Income"], broadCues: ["income", "rental income", "kita sa upa"], textCues: ["kita sa upa", "rental income", "bayad ng umuupa", "natanggap na upa"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },
  { preferred: ["Freelance", "Side Hustle", "Business"], broadCues: ["income", "freelance", "client payment", "income", "side hustle", "business income", "raket"], textCues: ["freelance", "invoice", "bayad ng kliyente", "kontrata", "side hustle", "raket", "sideline", "kita sa negosyo", "benta"], confidence: 0.82, reason: "Regional language merchant cues matched a known category." },

  // Remaining MD-plan category coverage.
  { preferred: ["Travel"], broadCues: ["travel", "trip", "tour", "vacation", "visa", "passport", "luggage"], textCues: ["travel", "tour", "visa", "passport", "luggage"], confidence: 0.78, reason: "md_plan_travel_filipino" },
  { preferred: ["Mortgage"], broadCues: ["housing", "mortgage", "home loan", "property loan", "loan"], textCues: ["mortgage", "home loan"], confidence: 0.82, reason: "md_plan_mortgage_filipino" },
  { preferred: ["Software & Apps"], broadCues: ["software", "app", "apps", "digital", "subscription", "software & apps", "google play"], textCues: ["app", "software", "Google Play", "App Store"], confidence: 0.82, reason: "md_plan_software_apps_filipino" },
  { preferred: ["Games"], broadCues: ["games", "gaming", "entertainment", "game", "laro", "steam"], textCues: ["laro", "gaming", "Steam", "PlayStation"], confidence: 0.82, reason: "md_plan_games_filipino" },
  { preferred: ["Electronics"], broadCues: ["electronics", "tech", "device", "shopping", "retail", "computer", "camera"], textCues: ["electronics", "computer", "camera", "Apple"], confidence: 0.82, reason: "md_plan_electronics_filipino" },
  { preferred: ["Clothing"], broadCues: ["clothing", "apparel", "fashion", "shopping", "retail", "damit"], textCues: ["damit", "clothing", "fashion", "Uniqlo"], confidence: 0.82, reason: "md_plan_clothing_filipino" },
  { preferred: ["Shoes"], broadCues: ["shoes", "footwear", "sneakers", "shopping", "retail", "sapatos", "nike"], textCues: ["sapatos", "sneakers", "Nike", "Adidas"], confidence: 0.82, reason: "md_plan_shoes_filipino" },
  { preferred: ["Beauty & Cosmetics"], broadCues: ["beauty", "cosmetics", "makeup", "skincare", "shopping", "retail", "beauty & cosmetics"], textCues: ["cosmetics", "makeup", "beauty"], confidence: 0.82, reason: "md_plan_beauty_cosmetics_filipino" },
  { preferred: ["Furniture"], broadCues: ["furniture", "home", "household", "decor", "sofa", "mattress"], textCues: ["furniture", "sofa", "mattress", "IKEA"], confidence: 0.82, reason: "md_plan_furniture_filipino" },
  { preferred: ["Home Improvement"], broadCues: ["home improvement", "hardware", "renovation", "repair", "home", "tools", "pintura"], textCues: ["hardware", "tools", "pintura", "renovation"], confidence: 0.82, reason: "md_plan_home_improvement_filipino" },
  { preferred: ["Shopping"], broadCues: ["shopping", "retail", "store", "marketplace", "shopee", "lazada"], textCues: ["shopping", "Shopee", "Lazada"], confidence: 0.78, reason: "md_plan_shopping_filipino" },
  { preferred: ["Doctor Visits"], broadCues: ["doctor", "medical", "clinic", "health", "healthcare", "doctor visits", "doktor", "medical center"], textCues: ["doktor", "clinic", "medical center"], confidence: 0.82, reason: "md_plan_doctor_visits_filipino" },
  // End remaining MD-plan category coverage.
];

export function maybeResolveSemanticCategory(
  ai: SemanticResolverAiInput | undefined,
  merchantNormalized: string,
  merchantRaw: string | null,
  allowedCategories: string[],
  aiResolvedCategory: string,
  uncategorizedKey: string,
  phase4ValidationFallback: boolean
): SemanticResolverDecision | null {
  const isUncategorized = normCategoryText(aiResolvedCategory) === normCategoryText(uncategorizedKey);
  if (!phase4ValidationFallback && !isUncategorized) return null;

  const broad = normalizeConcept(ai?.broadConcept);
  const cueText = resolverCueText([ai?.merchantClean, merchantNormalized, merchantRaw]);
  if (!cueText) return null;

  const resolve = (preferred: string[], confidence: number, reason: string): SemanticResolverDecision | null => {
    const categoryKey = pickFirstAllowed(allowedCategories, preferred);
    if (!categoryKey) return null;
    return {
      categoryKey,
      confidence,
      reason,
      source: "semantic_resolver"
    };
  };

  const shouldTrustRule = (rule: SemanticRule): boolean => {
    if (broad && hasResolverCue(broad, rule.broadCues)) return true;
    // If Gemini returned no usable row, we still want obvious brand/merchant cues
    // to rescue the transaction instead of failing fast as Uncategorized.
    return !broad && rule.confidence >= 0.82;
  };

  for (const rule of ENGLISH_SEMANTIC_RULES) {
    if (!shouldTrustRule(rule)) continue;
    if (!hasResolverCue(cueText, rule.textCues)) continue;
    const decision = resolve(rule.preferred, rule.confidence, rule.reason);
    if (decision) return decision;
  }

  for (const rule of TRADITIONAL_CHINESE_SEMANTIC_RULES) {
    if (!shouldTrustRule(rule)) continue;
    if (!hasResolverCue(cueText, rule.textCues)) continue;
    const decision = resolve(rule.preferred, rule.confidence, rule.reason);
    if (decision) return decision;
  }

  for (const rule of INDONESIAN_SEMANTIC_RULES) {
    if (!shouldTrustRule(rule)) continue;
    if (!hasResolverCue(cueText, rule.textCues)) continue;
    const decision = resolve(rule.preferred, rule.confidence, rule.reason);
    if (decision) return decision;
  }

  for (const rule of VIETNAMESE_SEMANTIC_RULES) {
    if (!shouldTrustRule(rule)) continue;
    if (!hasResolverCue(cueText, rule.textCues)) continue;
    const decision = resolve(rule.preferred, rule.confidence, rule.reason);
    if (decision) return decision;
  }

  for (const rule of MALAY_SEMANTIC_RULES) {
    if (!shouldTrustRule(rule)) continue;
    if (!hasResolverCue(cueText, rule.textCues)) continue;
    const decision = resolve(rule.preferred, rule.confidence, rule.reason);
    if (decision) return decision;
  }

  for (const rule of FILIPINO_SEMANTIC_RULES) {
    if (!shouldTrustRule(rule)) continue;
    if (!hasResolverCue(cueText, rule.textCues)) continue;
    const decision = resolve(rule.preferred, rule.confidence, rule.reason);
    if (decision) return decision;
  }

  return null;
}
