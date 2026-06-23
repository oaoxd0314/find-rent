// fb-scan 評分引擎的單元測試。純函式、不啟動瀏覽器
// (fb-scan.mjs 結尾的 import.meta.url 守衛讓「被 import」時不會跑 main)。
//   執行:pnpm test
import {
  parseRents,
  matchLocation,
  layoutScope,
  evaluateSearch,
  classifyPost,
} from './fb-scan.mjs';

// 測試用的兩組條件(對應實際 config 的形狀)
const S1 = {
  name: '條件1:整層住家',
  include: { rent_min: 10000, rent_max: 33000, layout: ['兩房一廳'], locations: ['信義', '大安'] },
  optional: { layout: ['一房一廳'], keywords: ['陽台', '洗衣機'] },
  exclude: { keywords: ['頂加'], locations: ['三重'] },
};
const S2 = {
  name: '條件2:女生友善',
  include: { rent_min: 10000, rent_max: 18000, layout: ['套房', '雅房'], locations: ['信義'] },
  optional: { roommate_female: true },
  exclude: { keywords: ['頂加'] },
};

const post = (text) => ({ text, rawText: text });
const ev = (text, search) => evaluateSearch(post(text), search);

describe('parseRents — 租金解析', () => {
  test('標籤型一般金額', () => expect(parseRents('租金 25000')).toEqual([25000]));
  test('萬', () => expect(parseRents('租金 1.5萬')).toEqual([15000]));
  test('區間兩端都收', () => expect(parseRents('租金 15000-18000')).toEqual([15000, 18000]));
  test('全形數字', () => expect(parseRents('租金 １５０００')).toEqual([15000]));
  test('租補後 → 只列原價', () =>
    expect(parseRents('一人入住NT$17,800 (租補後NT$12,200)')).toEqual([17800]));
  test('純 #租金補貼 hashtag 不誤抓', () =>
    expect(parseRents('#租金補貼 租金:15000')).toEqual([15000]));
});

describe('matchLocation — 地點精準比對', () => {
  test('複合詞「木新店」不誤判新店', () => expect(matchLocation('東森房屋木新店或臉書', '新店')).toBe(false));
  test('地名後綴(文山區)', () => expect(matchLocation('地址:文山區木新路', '文山')).toBe(true));
  test('方位詞(在新店)', () => expect(matchLocation('在新店租屋', '新店')).toBe(true));
  test('hashtag(#信義區)', () => expect(matchLocation('#信義區 採光好', '信義')).toBe(true));
  test('商圈後綴(信義商圈)', () => expect(matchLocation('信義商圈生活機能佳', '信義')).toBe(true));
  test('交通敘述「可直達內湖」不污染(地址在永和)', () =>
    expect(matchLocation('【地址】永和區保平路236巷15弄\n可直達台大醫院、內湖科技園區等地', '內湖')).toBe(false));
  test('地址欄位內命中(地址在內湖)', () =>
    expect(matchLocation('【地址】內湖區成功路三段\n鄰近永和', '內湖')).toBe(true));
  test('hashtag 命中(#永和 + 地址)', () =>
    expect(matchLocation('#永和 #整層\n【地址】永和區保平路30巷', '永和')).toBe(true));
  test('無地址欄位/hashtag → 退回全文', () =>
    expect(matchLocation('信義商圈生活機能佳', '信義')).toBe(true));
});

describe('matchLayout — 格局欄位優先(經 evaluateSearch)', () => {
  const S2real = {
    name: '條件2',
    include: { rent_min: 10000, rent_max: 18000, layout: ['套房'], locations: ['信義'] },
    optional: { layout: ['雅房'] },
    exclude: { keywords: [] },
  };
  const yafang = '格局：開放式空間（雅房）\n共1套房4雅房\n信義\n租金14000';
  test('格局欄位是雅房 → 套房 include 不全中,降為 uncertain', () =>
    expect(ev(yafang, S2real).verdict).toBe('uncertain'));
  test('格局欄位是套房 → match', () =>
    expect(ev('格局：獨立套房\n信義\n租金14000', S2real).verdict).toBe('match'));
  test('layoutScope 抽格局欄位值', () =>
    expect(layoutScope('格局：開放式空間（雅房）\n共1套房4雅房')).toBe('開放式空間（雅房）'));
  test('無格局欄位 → 退回全文', () =>
    expect(layoutScope('信義 套房出租 採光好')).toBe(null));
});

describe('evaluateSearch — GATE(唯一門檻:只有 exclude 會丟)', () => {
  test('exclude 關鍵字命中 → reject', () => expect(ev('信義 兩房一廳 頂加 租金20000', S1).verdict).toBe('reject'));
  test('exclude 地點命中 → reject', () => expect(ev('三重 兩房一廳 租金20000', S1).verdict).toBe('reject'));
  test('買賣文不在 exclude → 不丟(要丟請把關鍵字寫進 exclude)', () => {
    expect(ev('信義 兩房一廳 總價1500萬 出售 租金20000', S1).verdict).not.toBe('reject');
    const withSale = { ...S1, exclude: { ...S1.exclude, keywords: [...S1.exclude.keywords, '出售'] } };
    expect(ev('信義 兩房一廳 總價1500萬 出售 租金20000', withSale).verdict).toBe('reject');
  });
  test('求租文不在 exclude → 不丟', () =>
    expect(ev('求租 信義 兩房一廳 預算20000 租金20000', S1).verdict).not.toBe('reject'));
  test('租金超出範圍 → 不丟(只是租金那欄不加分)', () =>
    expect(ev('信義 兩房一廳 租金50000', S1).verdict).not.toBe('reject'));
  test('地點不在 allowed(板橋)→ 不丟,降為 uncertain', () =>
    expect(ev('板橋 兩房一廳 租金20000', S1).verdict).toBe('uncertain'));
  test('格局不符(套房進兩房一廳條件)→ 不丟,降為 uncertain', () =>
    // 地點(大安)+租金(25500)命中 → 進待確認;格局那欄不加分而已
    expect(ev('近大安森林捷運 套房 租金25500', S1).verdict).toBe('uncertain'));
});

describe('evaluateSearch — SCORE & TIER', () => {
  test('include 全中 → match,分 = 3欄×2', () => {
    const r = ev('信義 兩房一廳 租金20000', S1);
    expect(r.verdict).toBe('match');
    expect(r.score).toBe(6); // 租金(2) + layout(2) + locations(2)
  });
  test('租金未明 → 非全中,降為 uncertain', () => {
    const r = ev('信義 兩房一廳', S1);
    expect(r.verdict).toBe('uncertain');
    expect(r.score).toBe(4); // layout(2) + locations(2),租金未明不加分
  });
  test('部分符合 + optional 命中 → uncertain', () => {
    const r = ev('信義 一房一廳 陽台 洗衣機 租金20000', S1);
    expect(r.verdict).toBe('uncertain');
    // 租金(2) + locations 信義(2) + optional layout 一房一廳(1) + optional keywords 一次(1) = 6
    expect(r.score).toBe(6);
  });
  test('待確認區內 score 排序:命中越多分越高', () => {
    const more = ev('信義 一房一廳 陽台 租金20000', S1); // 租金(2)+loc(2)+opt layout(1)+opt kw(1)=6
    const less = ev('信義 一房一廳 租金20000', S1);        // 租金(2)+loc(2)+opt layout(1)=5
    expect(more.verdict).toBe('uncertain');
    expect(less.verdict).toBe('uncertain');
    expect(more.score).toBeGreaterThan(less.score);
  });
  test('零命中 → drop(reject)', () => {
    // 沒寫進 exclude、include/optional 也全不中 → score 0 → 不顯示
    const noLoc = { name: 'X', include: { layout: ['兩房一廳'] }, optional: { keywords: ['陽台'] } };
    expect(ev('套房出租 採光好', noLoc).verdict).toBe('reject');
  });
});

describe('evaluateSearch — 性別(roommate_female,獨立軸)', () => {
  test('偵測到男室友 → gender', () => {
    const r = ev('信義 雅房 租金14000\nroom A 男業務\nroom B 女秘書', S2);
    expect(r.verdict).toBe('gender');
  });
  test('「不要男生」否定句不誤判 → match(非 gender)', () => {
    expect(ev('信義 雅房 租金14000 徵女室友 不要男生', S2).verdict).toBe('match');
  });
  test('「男女不拘」不誤判 → match(非 gender)', () => {
    expect(ev('信義 雅房 租金14000 男女不拘', S2).verdict).toBe('match');
  });
});

describe('classifyPost — 跨條件取最佳(tie-break)', () => {
  test('S1 uncertain、S2 match → 取 match(條件2)', () => {
    const r = classifyPost(post('信義 套房 租金14000'), [S1, S2]);
    expect(r.verdict).toBe('match');
    expect(r.search).toBe('條件2:女生友善');
  });
  test('gender 高於 uncertain', () => {
    // 男訊號雅房在信義:S1→uncertain(地點命中)、S2→gender;取 gender
    const r = classifyPost(post('信義 雅房 租金14000 男室友一名'), [S1, S2]);
    expect(r.verdict).toBe('gender');
  });
});
