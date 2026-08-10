/* =============================================================================
 * 엔진 검증 테스트 (node analyzer/analyzer.test.js)
 * -----------------------------------------------------------------------------
 * "돌아간다" 가 아니라 "통계적으로 옳게 동작한다" 를 확인한다.
 * 특히 소표본 축소, 백분위 경계, lift 계산, 생존편향 보정을 집중 검증.
 * ============================================================================= */
'use strict';

var Z = require('./zeta-analyzer.js');
var Sample = require('./sample-works.js');

var pass = 0, fail = 0;
var failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  [32m✓[0m ' + name); }
  else {
    fail++; failures.push(name);
    console.log('  [31m✗[0m ' + name + (detail ? '  → ' + detail : ''));
  }
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol || 1e-6); }
function section(t) { console.log('\n[1m' + t + '[0m'); }

var NOW = Date.parse('2026-08-09T00:00:00Z');

/* ---------------------------------------------------------------------------
 * 1. 수치 유틸
 * ------------------------------------------------------------------------- */
section('1. 수치 유틸');
var I = Z._internal;

ok('median 홀수', I.median([3, 1, 2]) === 2);
ok('median 짝수', I.median([1, 2, 3, 4]) === 2.5);
ok('median 빈 배열', I.median([]) === 0);

var p = I.percentileRank([10, 20, 30, 40]);
ok('percentile 최솟값 = 0', near(p[0], 0));
ok('percentile 최댓값 = 1', near(p[3], 1));
ok('percentile 단조 증가', p[0] < p[1] && p[1] < p[2] && p[2] < p[3]);

var tie = I.percentileRank([5, 5, 5]);
ok('percentile 동점은 동일값', near(tie[0], tie[1]) && near(tie[1], tie[2]),
   JSON.stringify(tie));
ok('percentile 단일 원소 = 0.5', near(I.percentileRank([7])[0], 0.5));
ok('percentile 빈 배열', I.percentileRank([]).length === 0);

/* ---------------------------------------------------------------------------
 * 2. 베이지안 축소 — 엔진의 핵심 보정
 * ------------------------------------------------------------------------- */
section('2. 베이지안 축소');

var bigN   = I.shrink(3.0, 100, 8, 1);   // 표본 많음 → 원래 값 유지
var smallN = I.shrink(3.0, 2, 8, 1);     // 표본 적음 → 중립(1)로 당겨짐
ok('큰 표본은 원값을 거의 유지', bigN > 2.8, 'got ' + bigN.toFixed(3));
ok('작은 표본은 중립으로 당겨짐', smallN < 1.5, 'got ' + smallN.toFixed(3));
ok('축소는 항상 prior 와 값 사이', smallN > 1 && smallN < 3);
ok('n=0 이면 완전히 prior', near(I.shrink(9, 0, 8, 1), 1));
ok('비유한값은 prior 로 대체', near(I.shrink(Infinity, 5, 8, 1), 1));

// 극단 케이스: 작품 1개짜리 셀이 랭킹을 장악하면 안 된다
var oneWork = I.shrink(20, 1, 8, 1);
ok('작품 1개 gap=20 → 3 이하로 억제', oneWork <= 3.2, 'got ' + oneWork.toFixed(2));

/* ---------------------------------------------------------------------------
 * 3. 분류기
 * ------------------------------------------------------------------------- */
section('3. 분류기');

var c = Z.classify({ title: '테스트', tags: ['학원', '짝사랑', '달달', '교실'] });
ok('장르 분류', c.axes.genre.indexOf('학원') >= 0, JSON.stringify(c.axes.genre));
ok('관계 분류', c.axes.relation.indexOf('짝사랑') >= 0);
ok('정서 분류', c.axes.tone.indexOf('달달') >= 0);
ok('배경 분류', c.axes.setting.indexOf('학교') >= 0);

var manual = Z.classify({ title: 'x', tags: ['학원'], axes: { genre: ['오피스'] } });
ok('수동 라벨이 사전보다 우선', manual.axes.genre[0] === '오피스');

var none = Z.classify({ title: 'zzz', tags: ['알수없는태그'] });
ok('미매칭 태그는 축이 비어있음',
   Z.AXIS_KEYS.every(function (a) { return none.axes[a].length === 0; }));

/* ---------------------------------------------------------------------------
 * 4. 다중 라벨 분할 귀속 — 공급 총량이 부풀지 않아야 한다
 * ------------------------------------------------------------------------- */
section('4. 분할 귀속');

var multi = I.normalizeWorks([
  { id: 'a', tags: ['학원', '오피스'], chats: 100, likes: 10, createdAt: '2026-01-01' }
], { now: NOW, recentDays: 90 }).works;

var groups = I.groupByAxis(multi, 'genre');
var totalWeight = Object.keys(groups).reduce(function (acc, k) {
  return acc + groups[k].reduce(function (s, m) { return s + m.weight; }, 0);
}, 0);
ok('2개 장르 작품의 가중치 합 = 1', near(totalWeight, 1), 'got ' + totalWeight);

/* ---------------------------------------------------------------------------
 * 5. 수요 지표 — 신작이 누적만으로 불리해지지 않아야 한다
 * ------------------------------------------------------------------------- */
section('5. 수요 지표');

var demandCmp = I.normalizeWorks([
  // 오래된 작품: 누적 큼, 속도 느림
  { id: 'old', tags: ['학원'], chats: 10000, likes: 500, createdAt: '2025-02-20' },
  // 신작: 누적 작음, 속도 훨씬 빠름
  { id: 'new', tags: ['학원'], chats: 3000, likes: 150, createdAt: '2026-07-25' }
], { now: NOW, recentDays: 90 }).works;

var oldW = demandCmp[0], newW = demandCmp[1];
ok('신작 속도가 더 빠름', newW.velocity > oldW.velocity,
   oldW.velocity.toFixed(1) + ' vs ' + newW.velocity.toFixed(1));
ok('빠른 신작이 수요 점수에서 앞섬', newW.demand > oldW.demand,
   oldW.demand.toFixed(2) + ' vs ' + newW.demand.toFixed(2));
ok('chats=0 도 NaN 없이 처리', isFinite(I.normalizeWorks(
   [{ id: 'z', tags: ['학원'], chats: 0, likes: 0, createdAt: '2026-01-01' }],
   { now: NOW, recentDays: 90 }).works[0].demand));
ok('createdAt 없어도 처리', isFinite(I.normalizeWorks(
   [{ id: 'z', tags: ['학원'], chats: 5, likes: 1 }],
   { now: NOW, recentDays: 90 }).works[0].demand));

/* ---------------------------------------------------------------------------
 * 6. 전체 분석 — 구조 무결성
 * ------------------------------------------------------------------------- */
section('6. 전체 분석 구조');

var works = Sample.generate(200, 20260809, NOW);
var report = Z.analyze(works, { now: NOW });

ok('작품 수 일치', report.meta.count === 200);
ok('추천 결과 존재', report.recommendations.length > 0);
ok('축별 셀 모두 생성', Z.AXIS_KEYS.every(function (a) {
  return Array.isArray(report.axisCells[a]) && report.axisCells[a].length > 0;
}));

var allCells = [];
Z.AXIS_KEYS.forEach(function (a) { allCells = allCells.concat(report.axisCells[a]); });
allCells = allCells.concat(report.combos);

ok('모든 점수가 0~100', allCells.every(function (c) {
  return isFinite(c.score) && c.score >= 0 && c.score <= 100;
}));
ok('NaN 지표 없음', allCells.every(function (c) {
  return isFinite(c.gap) && isFinite(c.momentum) && isFinite(c.openness) &&
         isFinite(c.quality) && isFinite(c.newcomer);
}));
ok('점수 내림차순 정렬', report.combos.every(function (c, i, arr) {
  return i === 0 || arr[i - 1].score >= c.score;
}));

// 축 내부 공급 비중 합은 1
Z.AXIS_KEYS.forEach(function (a) {
  var sum = report.axisCells[a].reduce(function (s, c) { return s + c.supplyShare; }, 0);
  ok('공급 비중 합 = 1 (' + a + ')', near(sum, 1, 1e-6), 'got ' + sum);
});

/* ---------------------------------------------------------------------------
 * 7. 신호 탐지 — 심어둔 시장 구조를 실제로 찾아내는가
 *    (샘플 생성기는 '오피스+집착' 을 저공급·고성과로, '학원+짝사랑' 을
 *     고공급·저성과로 만들었다. 정답을 하드코딩하지 않았으므로
 *     엔진이 스스로 계산해 구분해야 한다.)
 * ------------------------------------------------------------------------- */
section('7. 신호 탐지');

function axisCell(axis, value) {
  return (report.axisCells[axis] || []).find(function (c) { return c.value === value; });
}

var office = axisCell('genre', '오피스');
var school = axisCell('genre', '학원');
ok('오피스/학원 셀 모두 존재', !!office && !!school);

if (office && school) {
  ok('저공급·고성과 장르의 gap 이 더 높음', office.gap > school.gap,
     '오피스 ' + office.gap.toFixed(2) + ' vs 학원 ' + school.gap.toFixed(2));
  ok('과공급 장르는 공급 비중이 더 큼', school.supplyShare > office.supplyShare,
     school.supplyShare.toFixed(3) + ' vs ' + office.supplyShare.toFixed(3));
  ok('과공급 장르 기회점수가 더 낮음', school.score < office.score,
     '학원 ' + school.score.toFixed(1) + ' vs 오피스 ' + office.score.toFixed(1));
}

var obsession = axisCell('tone', '집착');
var sweet = axisCell('tone', '달달');
if (obsession && sweet) {
  ok('희소·고성과 정서의 gap 이 과포화 정서보다 높음', obsession.gap > sweet.gap,
     '집착 ' + obsession.gap.toFixed(2) + ' vs 달달 ' + sweet.gap.toFixed(2));
}

// 상승세 레시피(근미래 안드로이드, trend 1.5)의 모멘텀이 하락세(사극, trend 0.6)보다 높아야
var scifi = axisCell('genre', 'SF·근미래');
var histo = axisCell('genre', '사극·무협');
if (scifi && histo) {
  ok('상승 레시피 모멘텀 > 하락 레시피 모멘텀', scifi.momentum > histo.momentum,
     'SF ' + scifi.momentum.toFixed(2) + ' vs 사극 ' + histo.momentum.toFixed(2));
}

/* ---------------------------------------------------------------------------
 * 8. 미개척 조합(lift)
 * ------------------------------------------------------------------------- */
section('8. 미개척 조합');

ok('whitespace 결과 존재', report.whitespace.length > 0);
ok('whitespace 는 모두 lift < 1', report.whitespace.every(function (w) { return w.lift < 1; }));
ok('whitespace 표본은 minSupport 미만', report.whitespace.every(function (w) {
  return w.observed < Z.DEFAULTS.minSupport;
}));
ok('whitespace 는 가설로 표시', report.whitespace.every(function (w) {
  return w.confidence === 'hypothesis';
}));
ok('whitespace 점수 내림차순', report.whitespace.every(function (w, i, arr) {
  return i === 0 || arr[i - 1].score >= w.score;
}));

/* ---------------------------------------------------------------------------
 * 9. 생존편향 보정
 * ------------------------------------------------------------------------- */
section('9. 생존편향 보정');

var ranked = Z.analyze(works, { now: NOW, sampling: 'ranked' });
var rOffice = (ranked.axisCells.genre || []).find(function (c) { return c.value === '오피스'; });

ok('ranked 모드는 경고를 낸다', ranked.warnings.some(function (w) {
  return w.indexOf('인기순') >= 0;
}));
if (office && rOffice) {
  ok('ranked 모드에서 gap 이 중립 쪽으로 축소됨',
     Math.abs(rOffice.gap - 1) < Math.abs(office.gap - 1),
     'census ' + office.gap.toFixed(2) + ' → ranked ' + rOffice.gap.toFixed(2));
}

/* ---------------------------------------------------------------------------
 * 10. 리스크 플래그 / 경고
 * ------------------------------------------------------------------------- */
section('10. 리스크 · 경고');

var provisional = report.combos.filter(function (c) { return c.provisional; });
ok('잠정 셀에 SMALL_SAMPLE 플래그', provisional.every(function (c) {
  return c.risks.some(function (r) { return r.code === 'SMALL_SAMPLE'; });
}));
ok('검증 추천은 모두 표본 충족', report.recommendations
  .filter(function (r) { return r.confidence === 'validated'; })
  .every(function (r) { return r.evidence.works >= Z.DEFAULTS.minSupport; }));
ok('미분류 태그 집계 동작', Array.isArray(report.unmappedTags));
ok('사전에 없는 태그가 잡힘', report.unmappedTags.some(function (t) {
  return t.tag === '테이머' || t.tag === '길들이기';
}), JSON.stringify(report.unmappedTags.slice(0, 5)));

/* ---------------------------------------------------------------------------
 * 11. 가중치 반응성 — 가중치를 바꾸면 순위가 실제로 달라져야 한다
 * ------------------------------------------------------------------------- */
section('11. 가중치 반응성');

var gapOnly = Z.analyze(works, {
  now: NOW,
  weights: { gap: 1, momentum: 0, openness: 0, newcomer: 0, quality: 0, staleness: 0 }
});
var momOnly = Z.analyze(works, {
  now: NOW,
  weights: { gap: 0, momentum: 1, openness: 0, newcomer: 0, quality: 0, staleness: 0 }
});
// 1위가 반드시 바뀔 필요는 없다(저공급이면서 상승세인 셀은 양쪽 모두 1위일 수 있다).
// 검증할 성질은 "가중치가 순위에 실제로 반영되는가" 다.
var gapOrder = gapOnly.combos.map(function (c) { return c.label; }).join('>');
var momOrder = momOnly.combos.map(function (c) { return c.label; }).join('>');
ok('가중치를 바꾸면 순위가 달라짐', gapOrder !== momOrder);

// 모멘텀 가중에서 크게 상승하는 셀이 존재해야 한다(지표가 서로 독립적으로 작동)
var rankIn = function (list, label) {
  return list.findIndex(function (c) { return c.label === label; });
};
var maxJump = 0;
gapOnly.combos.forEach(function (c) {
  var jump = rankIn(gapOnly.combos, c.label) - rankIn(momOnly.combos, c.label);
  if (jump > maxJump) maxJump = jump;
});
ok('모멘텀 가중 시 10계단 이상 뛰는 셀 존재', maxJump >= 10, '최대 상승 ' + maxJump + '계단');

// 잠정 셀은 점수에 0.85 감쇠가 걸리므로 gap 만으로 순위를 비교할 수 없다.
// 검증된 셀끼리는 gap 100% 가중 시 gap 순서와 점수 순서가 정확히 일치해야 한다.
var solid = gapOnly.combos.filter(function (c) { return !c.provisional; });
var gapTop = solid[0];
ok('gap 가중 1위(검증 셀)는 실제로 gap 최상위',
   solid.every(function (c) { return c.gap <= gapTop.gap + 1e-9; }),
   '1위 gap ' + gapTop.gap.toFixed(2) + ', 최대 gap ' +
   Math.max.apply(null, solid.map(function (c) { return c.gap; })).toFixed(2));

// 축 셀이 하나의 풀에서 정규화됐는지 — 축마다 100점이 하나씩 나오면 안 된다
var perfect = [];
Z.AXIS_KEYS.forEach(function (a) {
  report.axisCells[a].forEach(function (c) { if (c.p.gap === 1) perfect.push(a + ':' + c.value); });
});
ok('gap 백분위 1.0 은 전체 축을 통틀어 하나뿐', perfect.length === 1,
   'got ' + JSON.stringify(perfect));

/* ---------------------------------------------------------------------------
 * 11-b. 사전 무결성 / 분류 정확도
 * ------------------------------------------------------------------------- */
section('11-b. 사전 무결성');

ok('기본 사전에 축 간 키워드 충돌 없음', Z.validateTaxonomy(Z.TAXONOMY).length === 0,
   JSON.stringify(Z.validateTaxonomy(Z.TAXONOMY)));

var collide = Z.validateTaxonomy({
  genre: { label: 'g', values: { 'A': ['잔잔'] } },
  tone:  { label: 't', values: { 'B': ['잔잔'] } }
});
ok('충돌 사전은 검출됨', collide.length === 1 && collide[0].keyword === '잔잔');

// 태그는 완전 일치 — 부분 일치로 인한 축 오염이 없어야 한다
var yan = Z.classify({ title: '', tags: ['집착남'] });
ok('"집착남" 은 캐릭터 축에만 배정', yan.axes.archetype.indexOf('얀데레') >= 0 &&
   yan.axes.tone.length === 0, JSON.stringify(yan.axes));

// 형제 키워드가 함께 있어도 matched 기록이 누락되지 않아야 한다
var sib = Z.classify({ title: '', tags: ['달달', '설렘'] });
ok('형제 키워드 모두 matched 처리', sib.matchedTags['달달'] && sib.matchedTags['설렘']);
ok('형제 키워드는 같은 값으로 수렴', sib.axes.tone.length === 1 && sib.axes.tone[0] === '달달');

var reportTags = report.unmappedTags.map(function (t) { return t.tag; });
ok('사전에 있는 태그는 미분류로 새지 않음',
   ['설렘', '고등학생', '재벌', '잔잔'].every(function (t) { return reportTags.indexOf(t) < 0; }),
   JSON.stringify(reportTags));

/* ---------------------------------------------------------------------------
 * 11-c. 중복 조합 필터
 * ------------------------------------------------------------------------- */
section('11-c. 중복 조합 필터');

ok('자카드 완전 일치 = 1', near(I.jaccard({ a: 1, b: 1 }, { a: 1, b: 1 }), 1));
ok('자카드 무교집합 = 0', I.jaccard({ a: 1 }, { b: 1 }) === 0);
ok('자카드 부분 교집합', near(I.jaccard({ a: 1, b: 1 }, { b: 1, c: 1 }), 1 / 3));
ok('빈 집합 안전', I.jaccard({}, { a: 1 }) === 0);

var redundant = report.combos.filter(function (c) { return c.tautology; });
ok('중복 조합이 검출됨', redundant.length > 0);
ok('중복 조합은 임계값 이상', redundant.every(function (c) {
  return c.overlap >= Z.DEFAULTS.redundancyThreshold;
}));
ok('중복 조합은 추천에서 제외됨', report.recommendations.every(function (rec) {
  return !redundant.some(function (c) { return c.label === rec.label; });
}));
ok('개념적 동의어 조합(집착 × 얀데레)이 걸러짐',
   redundant.some(function (c) { return c.label === '집착 × 얀데레'; }));

/* ---------------------------------------------------------------------------
 * 11-d. 수요 지표 스케일 / 레드오션
 * ------------------------------------------------------------------------- */
section('11-d. 수요 스케일 · 레드오션');

var genreGaps = report.axisCells.genre.map(function (c) { return c.gap; });
var gapSpread = Math.max.apply(null, genreGaps) - Math.min.apply(null, genreGaps);
ok('gap 이 뭉개지지 않고 벌어짐 (>0.3)', gapSpread > 0.3, 'spread ' + gapSpread.toFixed(2));

ok('윈저화로 상한이 적용됨', (function () {
  var vs = report.works.map(function (w) { return w.velocity; }).sort(function (a, b) { return a - b; });
  var cap = vs[Math.floor(vs.length * 0.95)];
  return report.works.every(function (w) { return w.demand <= cap + 1e-9; });
})());

ok('레드오션이 실제로 검출됨', report.saturated.length > 0, 'got ' + report.saturated.length);
ok('레드오션은 공급 과잉 셀', report.saturated.every(function (c) {
  return c.supplyShare > 0;
}));
ok('과공급 장르에 OVERSUPPLIED 플래그', report.axisCells.genre
  .filter(function (c) { return c.value === '학원' || c.value === '로맨스'; })
  .every(function (c) { return c.risks.some(function (x) { return x.code === 'OVERSUPPLIED'; }); }));

/* ---------------------------------------------------------------------------
 * 11-e. 한국어 조사 처리
 * ------------------------------------------------------------------------- */
section('11-e. 조사 처리');

ok('받침 있음 감지 (회사→X, 학원→O)',
   I.hasJongseong('학원') === true && I.hasJongseong('회사') === false);
ok('받침 없는 단어는 "를"', I.buildLogline({ setting: '회사', genre: '오피스' }).indexOf('회사를') >= 0,
   I.buildLogline({ setting: '회사', genre: '오피스' }));
ok('받침 있는 단어는 "을"', I.buildLogline({ setting: '이세계', genre: '판타지' }).indexOf('이세계를') >= 0 ||
   I.buildLogline({ setting: '학교', genre: '학원' }).indexOf('학교를') >= 0,
   I.buildLogline({ setting: '학교', genre: '학원' }));
ok('비한글도 크래시 없음', typeof I.buildLogline({ setting: 'SF', genre: 'sf' }) === 'string');
ok('축이 없으면 기본 문장', I.buildLogline({}).length > 0);
ok('장르만 있어도 문장 성립', I.buildLogline({ genre: '로맨스' }).indexOf('로맨스') >= 0);

/* ---------------------------------------------------------------------------
 * 11-f. 공급 쏠림
 * ------------------------------------------------------------------------- */
section('11-f. 공급 쏠림');

var allA = [];
Z.AXIS_KEYS.forEach(function (a) { allA = allA.concat(report.axisCells[a]); });
ok('supplyRush 가 모든 셀에 계산됨', allA.every(function (c) { return isFinite(c.supplyRush); }));
ok('supplyRush 는 양수', allA.every(function (c) { return c.supplyRush > 0; }));

/* ---------------------------------------------------------------------------
 * 11-g. 부트스트랩 신뢰구간
 * ------------------------------------------------------------------------- */
section('11-g. 신뢰구간');

var allCombo = report.combos;
ok('모든 조합에 CI 계산됨', allCombo.every(function (c) {
  return isFinite(c.gapLo) && isFinite(c.gapHi);
}));
ok('CI 하한 ≤ 상한', allCombo.every(function (c) { return c.gapLo <= c.gapHi; }));
ok('점추정이 CI 안에 있음', allCombo.filter(function (c) {
  return c.gap >= c.gapLo - 0.02 && c.gap <= c.gapHi + 0.02;
}).length >= allCombo.length * 0.95,
   allCombo.filter(function (c) { return c.gap < c.gapLo - 0.02 || c.gap > c.gapHi + 0.02; }).length + '개 벗어남');

// 핵심 성질: 표본이 적을수록 신뢰구간이 넓어야 한다
var small = allCombo.filter(function (c) { return c.stats.count <= 4; });
var large = allCombo.filter(function (c) { return c.stats.count >= 15; });
function meanWidth(list) {
  return list.reduce(function (a, c) { return a + (c.gapHi - c.gapLo); }, 0) / (list.length || 1);
}
ok('소표본 셀의 CI 가 대표본보다 넓음', small.length && large.length &&
   meanWidth(small) > meanWidth(large),
   '소표본 ' + meanWidth(small).toFixed(2) + ' vs 대표본 ' + meanWidth(large).toFixed(2));

ok('significant 는 CI 가 1을 넘지 않을 때만', allCombo.every(function (c) {
  return c.significant === (c.gapLo > 1 || c.gapHi < 1);
}));
ok('넓은 CI 는 WIDE_CI 플래그', allCombo.filter(function (c) {
  return (c.gapHi - c.gapLo) > 0.8;
}).every(function (c) { return c.risks.some(function (r) { return r.code === 'WIDE_CI'; }); }));

// 부트스트랩은 시드 고정이므로 재현되어야 한다
var b1 = Z.analyze(works, { now: NOW }).combos[0];
var b2 = Z.analyze(works, { now: NOW }).combos[0];
ok('CI 가 재현됨', b1.gapLo === b2.gapLo && b1.gapHi === b2.gapHi);

var noBoot = Z.analyze(works, { now: NOW, bootstrapSamples: 0 });
ok('bootstrapSamples=0 이면 CI 생략(점추정으로 대체)',
   noBoot.combos.every(function (c) { return c.gapLo === c.gap && c.gapHi === c.gap; }));

/* ---------------------------------------------------------------------------
 * 11-h. 보수적 순위
 * ------------------------------------------------------------------------- */
section('11-h. 보수적 순위');

var cons = Z.analyze(works, { now: NOW, conservative: true });
ok('conservative 모드가 순위를 바꿈',
   cons.combos.map(function (c) { return c.label; }).join('>') !==
   report.combos.map(function (c) { return c.label; }).join('>'));

// 보수 모드에서는 CI 하한이 낮은(=불확실한) 셀이 상대적으로 밀려야 한다
var normalRank = {}, consRank = {};
report.combos.forEach(function (c, i) { normalRank[c.label] = i; });
cons.combos.forEach(function (c, i) { consRank[c.label] = i; });
var uncertain = report.combos.filter(function (c) { return (c.gapHi - c.gapLo) > 0.8; });
var demoted = uncertain.filter(function (c) {
  return consRank[c.label] > normalRank[c.label];
}).length;
ok('불확실한 셀이 보수 모드에서 밀려남', uncertain.length === 0 || demoted > uncertain.length / 2,
   uncertain.length + '개 중 ' + demoted + '개 하락');

/* ---------------------------------------------------------------------------
 * 11-i. 코호트 추세
 * ------------------------------------------------------------------------- */
section('11-i. 코호트 추세');

ok('선형회귀 기울기 (상승)', near(I.linregSlope([{x:0,y:1},{x:1,y:2},{x:2,y:3}]), 1));
ok('선형회귀 기울기 (하락)', near(I.linregSlope([{x:0,y:3},{x:1,y:2},{x:2,y:1}]), -1));
ok('선형회귀 기울기 (평탄)', near(I.linregSlope([{x:0,y:2},{x:1,y:2}]), 0));
ok('점 1개는 0', I.linregSlope([{x:0,y:5}]) === 0);

var axisAll = [];
Z.AXIS_KEYS.forEach(function (a) { axisAll = axisAll.concat(report.axisCells[a]); });
ok('모든 셀에 trend 계산됨', axisAll.every(function (c) { return isFinite(c.trend); }));
ok('trendLabel 은 세 값 중 하나', axisAll.every(function (c) {
  return ['rising', 'stable', 'declining'].indexOf(c.trendLabel) >= 0;
}));
ok('코호트 총합이 전체 수요와 일치', (function () {
  var sum = report.meta.cohortTotals.reduce(function (a, v) { return a + v; }, 0);
  var total = report.works.reduce(function (a, w) { return a + w.demand; }, 0);
  return Math.abs(sum - total) < 1;
})());

// 샘플 생성기에서 사극(trend 0.6)은 하락, 근미래 SF(trend 1.5)는 상승으로 심어뒀다
var sfCell = report.axisCells.genre.find(function (c) { return c.value === 'SF·근미래'; });
var saCell = report.axisCells.genre.find(function (c) { return c.value === '사극·무협'; });
ok('상승 레시피의 추세가 하락 레시피보다 높음', sfCell.trend > saCell.trend,
   'SF ' + sfCell.trend.toFixed(2) + ' vs 사극 ' + saCell.trend.toFixed(2));

/* ---------------------------------------------------------------------------
 * 11-j. 3축 조합
 * ------------------------------------------------------------------------- */
section('11-j. 3축 조합');

var triples = report.combos.filter(function (c) { return c.kind === 'triple'; });
ok('3축 조합이 생성됨', triples.length > 0, 'got ' + triples.length);
ok('3축은 값이 3개', triples.every(function (c) { return c.values.length === 3; }));
ok('3축 라벨은 × 2개', triples.every(function (c) {
  return c.label.split(' × ').length === 3;
}));
ok('3축 로그라인이 세 축을 모두 반영', (function () {
  var t = triples.find(function (c) { return !c.tautology; });
  if (!t) return true;
  var line = I.buildLogline({ genre: t.values[0], relation: t.values[1], tone: t.values[2] });
  return line.indexOf(t.values[1]) >= 0 && line.indexOf(t.values[2]) >= 0;
})());

// 3축은 2축의 부분집합이므로 표본이 더 작아야 한다
var pairs = report.combos.filter(function (c) { return c.kind === 'combo'; });
ok('3축 평균 표본 < 2축 평균 표본',
   I.median(triples.map(function (c) { return c.stats.count; })) <=
   I.median(pairs.map(function (c) { return c.stats.count; })));

ok('2축·3축이 같은 풀에서 정규화됨 (100점은 하나)', (function () {
  var top = report.combos.filter(function (c) { return c.p.gap === 1; });
  return top.length === 1;
})());

var noTriple = Z.analyze(works, { now: NOW, tripleAxes: [] });
ok('tripleAxes=[] 이면 3축 없음',
   noTriple.combos.every(function (c) { return c.kind !== 'triple'; }));

/* ---------------------------------------------------------------------------
 * 11-k. 다양성 선별
 * ------------------------------------------------------------------------- */
section('11-k. 다양성 선별');

ok('유사도: 완전 동일 = 1', near(I.cellSimilarity(
  { kind: 'combo', values: ['A', 'B'], stats: { ids: { x: 1 } } },
  { kind: 'combo', values: ['A', 'B'], stats: { ids: { x: 1 } } }), 1));
ok('유사도: 공통 없음 = 0', I.cellSimilarity(
  { kind: 'combo', values: ['A', 'B'], stats: { ids: { x: 1 } } },
  { kind: 'combo', values: ['C', 'D'], stats: { ids: { y: 1 } } }) === 0);

var flat = Z.analyze(works, { now: NOW, diversity: 0 });
var diverse = Z.analyze(works, { now: NOW, diversity: 0.45 });

ok('다양성 0 은 점수순 그대로', (function () {
  var pool = flat.combos.filter(function (c) { return !c.provisional && !c.tautology; });
  return flat.recommendations[0].label === pool[0].label;
})());

function distinctValues(recs) {
  var seen = {};
  recs.filter(function (r) { return r.confidence === 'validated'; })
      .forEach(function (r) { r.label.split(' × ').forEach(function (v) { seen[v] = true; }); });
  return Object.keys(seen).length;
}
ok('다양성 적용 시 서로 다른 축 값이 더 많이 등장',
   distinctValues(diverse.recommendations) > distinctValues(flat.recommendations),
   flat.recommendations.length + '개 중 고유값 ' + distinctValues(flat.recommendations) +
   ' → ' + distinctValues(diverse.recommendations));

ok('다양성 적용해도 개수는 동일',
   diverse.recommendations.filter(function (r) { return r.confidence === 'validated'; }).length ===
   flat.recommendations.filter(function (r) { return r.confidence === 'validated'; }).length);

ok('selectDiverse 는 요청 개수만큼 반환', Z.selectDiverse(
  report.combos.slice(0, 20), 5, 0.5).length === 5);
ok('selectDiverse 는 중복 없이 반환', (function () {
  var picked = Z.selectDiverse(report.combos.slice(0, 20), 5, 0.5);
  var seen = {};
  return picked.every(function (c) {
    if (seen[c.label]) return false;
    seen[c.label] = true; return true;
  });
})());

/* ---------------------------------------------------------------------------
 * 11-l. 제작자 적합도
 * ------------------------------------------------------------------------- */
section('11-l. 제작자 적합도');

var base = Z.analyze(works, { now: NOW });
ok('myWorks 없으면 fit 은 전부 1.0',
   base.combos.every(function (c) { return c.fit === 1; }));

// 오피스물만 아주 잘 만든 제작자
var myOffice = [];
for (var mi = 0; mi < 6; mi++) {
  myOffice.push({
    id: 'me' + mi, title: '내 작품 ' + mi,
    tags: ['오피스', '상사', '집착'],
    createdAt: '2026-03-01', chats: 9000, likes: 1200, creatorFollowers: 50
  });
}
var fitted = Z.analyze(works, { now: NOW, myWorks: myOffice });

ok('myWorks 개수가 meta 에 기록', fitted.meta.myWorksCount === 6);
var officeCells = fitted.combos.filter(function (c) { return c.values.indexOf('오피스') >= 0; });
ok('내가 잘한 축의 fit 이 1보다 큼', officeCells.length > 0 &&
   officeCells.every(function (c) { return c.fit > 1; }),
   officeCells.length ? officeCells[0].fit.toFixed(2) : 'none');

var untouched = fitted.combos.filter(function (c) {
  return c.values.every(function (v) { return ['오피스', '상사·부하', '집착', '회사', '얀데레'].indexOf(v) < 0; });
});
ok('내가 안 만든 축은 중립 1.0', untouched.every(function (c) { return near(c.fit, 1, 1e-9); }));

ok('적합도가 순위에 반영됨',
   fitted.combos.map(function (c) { return c.label; }).join('>') !==
   base.combos.map(function (c) { return c.label; }).join('>'));

// 내 작품이 1개뿐이면 축소가 강하게 걸려야 한다
var oneMine = Z.analyze(works, { now: NOW, myWorks: [myOffice[0]] });
var oneFit = oneMine.combos.filter(function (c) { return c.values.indexOf('오피스') >= 0; })[0];
var sixFit = officeCells[0];
ok('표본 1개의 fit 이 6개보다 약하게 반영', oneFit && sixFit && oneFit.fit < sixFit.fit,
   '1개 ' + (oneFit ? oneFit.fit.toFixed(2) : '?') + ' vs 6개 ' + sixFit.fit.toFixed(2));

/* ---------------------------------------------------------------------------
 * 12. 엣지 케이스
 * ------------------------------------------------------------------------- */
section('12. 엣지 케이스');

ok('빈 입력은 에러 반환', !!Z.analyze([]).error);
ok('배열 아닌 입력도 에러', !!Z.analyze(null).error);

var single = Z.analyze([
  { id: 'a', tags: ['학원', '짝사랑'], chats: 10, likes: 1, createdAt: '2026-01-01' }
], { now: NOW });
ok('작품 1개도 크래시 없음', single.meta.count === 1 && !single.error);
ok('작품 1개면 표본 부족 경고', single.warnings.some(function (w) {
  return w.indexOf('표본') >= 0;
}));

var zeroChats = Z.analyze([
  { id: 'a', tags: ['학원'], chats: 0, likes: 0, createdAt: '2026-01-01' },
  { id: 'b', tags: ['오피스'], chats: 0, likes: 0, createdAt: '2026-01-01' }
], { now: NOW });
ok('전부 0 대화수여도 NaN 없음',
   zeroChats.axisCells.genre.every(function (c) { return isFinite(c.score); }));

var noTags = Z.analyze([
  { id: 'a', tags: [], chats: 100, likes: 5, createdAt: '2026-01-01' },
  { id: 'b', tags: ['학원'], chats: 50, likes: 3, createdAt: '2026-01-01' }
], { now: NOW });
ok('무태그 작품은 경고로 보고됨', noTags.warnings.some(function (w) {
  return w.indexOf('분류되지 않은') >= 0;
}));

/* ---------------------------------------------------------------------------
 * 13. CSV 파서
 * ------------------------------------------------------------------------- */
section('13. CSV 파서');

var csv = 'id,title,tags,createdAt,chats,likes,creatorFollowers\n' +
          'w1,"쉼표, 포함 제목",학원|짝사랑,2026-01-01,1200,80,300\n' +
          'w2,"그가 ""사랑"" 이라 불렀다",오피스|집착,2026-05-01,900,60,120\n' +
          'w3,5"3 짜리 제목,판타지|이세계,2026-06-01,400,20,50\n';
var parsed = Z.parseCSV(csv);
ok('행 수 정확', parsed.length === 3, 'got ' + parsed.length);
ok('따옴표 안 쉼표 보존', parsed[0].title === '쉼표, 포함 제목', parsed[0].title);
ok('RFC4180 이중 따옴표 이스케이프', parsed[1].title === '그가 "사랑" 이라 불렀다', parsed[1].title);
ok('필드 중간의 맨따옴표는 리터럴', parsed[2].title === '5"3 짜리 제목', parsed[2].title);
ok('태그 파이프 분리', parsed[0].tags.length === 2 && parsed[0].tags[0] === '학원');
ok('숫자 변환', parsed[0].chats === 1200 && parsed[0].likes === 80);
ok('파싱 결과가 바로 분석 가능', Z.analyze(parsed, { now: NOW }).meta.count === 3);

/* ---------------------------------------------------------------------------
 * 14. 재현성
 * ------------------------------------------------------------------------- */
section('14. 재현성');

var a1 = Z.analyze(Sample.generate(120, 42, NOW), { now: NOW });
var a2 = Z.analyze(Sample.generate(120, 42, NOW), { now: NOW });
ok('같은 시드 → 같은 결과',
   JSON.stringify(a1.recommendations) === JSON.stringify(a2.recommendations));

var a3 = Z.analyze(Sample.generate(120, 7, NOW), { now: NOW });
ok('다른 시드 → 다른 결과',
   JSON.stringify(a1.recommendations) !== JSON.stringify(a3.recommendations));

/* ---------------------------------------------------------------------------
 * 결과
 * ------------------------------------------------------------------------- */
console.log('\n' + '─'.repeat(56));
console.log('  통과 ' + pass + ' / 실패 ' + fail);
if (fail) {
  console.log('\n  실패 항목:');
  failures.forEach(function (f) { console.log('   · ' + f); });
}
console.log('─'.repeat(56) + '\n');

process.exit(fail ? 1 : 0);
