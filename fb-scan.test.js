// fb-scan 評分引擎的單元測試。純函式、不啟動瀏覽器
// (fb-scan.mjs 結尾的 import.meta.url 守衛讓「被 import」時不會跑 main)。
//   執行:pnpm test
import {
  parseRents,
  matchLocation,
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
});

describe('evaluateSearch — GATE(門檻,reject)', () => {
  test('exclude 關鍵字命中 → reject', () => expect(ev('信義 兩房一廳 頂加 租金20000', S1).verdict).toBe('reject'));
  test('exclude 地點命中 → reject', () => expect(ev('三重 兩房一廳 租金20000', S1).verdict).toBe('reject'));
  test('買賣文 → reject', () => expect(ev('信義 兩房一廳 總價1500萬 出售', S1).verdict).toBe('reject'));
  test('求租文 → reject', () => expect(ev('求租 信義 兩房一廳 預算20000', S1).verdict).toBe('reject'));
  test('租金整段超出範圍 → reject', () => expect(ev('信義 兩房一廳 租金50000', S1).verdict).toBe('reject'));
  test('地點門檻:不在 allowed(板橋)→ reject', () =>
    expect(ev('板橋 兩房一廳 租金20000', S1).verdict).toBe('reject'));
  test('租補後排除後原價超出 → reject(複合驗證)', () =>
    // 月租20000、租補後16000;subsidy 排掉 16000 → 只剩 20000 > S2 上限 18000 → 擋掉
    expect(ev('信義 套房 月租20000 租補後16000', S2).verdict).toBe('reject'));
});

describe('evaluateSearch — SCORE & TIER', () => {
  test('include 全中 → match,分 = 2欄×2', () => {
    const r = ev('信義 兩房一廳 租金20000', S1);
    expect(r.verdict).toBe('match');
    expect(r.score).toBe(4); // layout(2) + locations(2)
  });
  test('租金未明仍放行(保守)→ match', () => {
    expect(ev('信義 兩房一廳', S1).verdict).toBe('match');
  });
  test('部分符合 + optional 命中 → uncertain', () => {
    const r = ev('信義 一房一廳 陽台 洗衣機 租金20000', S1);
    expect(r.verdict).toBe('uncertain');
    // locations 信義(2) + optional layout 一房一廳(1) + optional keywords 命中一次(1) = 4
    expect(r.score).toBe(4);
  });
  test('待確認區內 score 排序:命中越多分越高', () => {
    const more = ev('信義 一房一廳 陽台 租金20000', S1); // loc(2)+opt layout(1)+opt kw(1)=4
    const less = ev('信義 一房一廳 租金20000', S1);        // loc(2)+opt layout(1)=3
    expect(more.verdict).toBe('uncertain');
    expect(less.verdict).toBe('uncertain');
    expect(more.score).toBeGreaterThan(less.score);
  });
  test('零命中 → drop(reject)', () => {
    // 無 location 門檻的條件,layout 與 optional 全不中 → score 0 → 不顯示
    const noLoc = { name: 'X', include: { layout: ['兩房一廳'] }, optional: { keywords: ['陽台'] } };
    expect(ev('套房出租 採光好', noLoc).verdict).toBe('reject');
  });
  test('格局門檻:套房不該進「兩房一廳」條件 → drop', () => {
    // 即使地點(大安)命中,格局是套房 → 不在 allowed layout(兩房一廳/一房一廳)→ 丟
    expect(ev('近大安森林捷運 套房 租金25500', S1).verdict).toBe('reject');
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
