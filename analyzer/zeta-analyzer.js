/* =============================================================================
 * ZETA Theme Opportunity Analyzer (TOA)
 * -----------------------------------------------------------------------------
 * "어떤 주제의 작품을 만들면 좋은가" 를 데이터로 계산하는 분석 엔진.
 *
 * 입력 : 작품 목록(Work[])  — 태그 / 생성일 / 대화수 / 좋아요 / 제작자 팔로워
 * 출력 : 축별 기회 랭킹, 조합 추천, 미개척(whitespace) 조합, 레드오션 경고
 *
 * 설계 요지
 *  1) 원시 태그를 5개 축(장르·관계·정서·배경·캐릭터)으로 사전 매핑한다.
 *  2) 다중 라벨은 1/n 로 분할 귀속해 셀 합계가 부풀지 않게 한다.
 *  3) 수요는 누적 대화수가 아니라 "일평균 속도 + 누적" 을 로그 스케일로 섞는다.
 *     (누적만 쓰면 오래된 작품이 항상 이기고 신작 신호가 사라진다)
 *  4) 수요/공급 비율(gap)은 표본이 적을수록 중립값 1로 당긴다(베이지안 축소).
 *     이 보정이 없으면 "작품 2개짜리 희귀 조합" 이 항상 1위가 된다.
 *  5) 모든 지표는 백분위로 정규화한 뒤 가중합 → 0~100 기회점수.
 *  6) 조합은 lift(관측/기대)로 판단한다. 각 축은 인기인데 조합은 희소하면
 *     미개척 후보, 조합이 과밀한데 gap 이 낮으면 레드오션이다.
 *
 * Node / 브라우저 양쪽에서 동작한다.
 * ============================================================================= */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ZetaAnalyzer = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* ===========================================================================
   * 1. 택소노미 — 원시 태그를 축(axis)으로 매핑하는 사전
   *    values 의 각 배열은 "이 값으로 분류할 키워드" 목록이다.
   *    실제 서비스 데이터에 맞게 이 사전만 갱신하면 나머지는 그대로 동작한다.
   * ========================================================================= */
  /* 규칙: 하나의 키워드는 정확히 하나의 축에만 속해야 한다.
   * 예전 사전은 '잔잔' 이 genre(일상·힐링)와 tone(잔잔)에 동시에 있어서
   * "일상·힐링 × 잔잔" 같은 동어반복 조합이 추천 상위로 올라왔다.
   * validateTaxonomy() 가 이 규칙 위반을 검사한다. */
  var TAXONOMY = {
    genre: {
      label: '장르',
      values: {
        '로맨스':      ['로맨스', '연애', '러브', '썸', '사랑', '연상연하', '연하남', '연상녀', '순애', '멜로'],
        '판타지':      ['판타지', '마법', '마법사', '이능', '초능력', '마왕', '용사', '엘프', '수인', '드래곤', '기사단', '헌터', '각성'],
        '학원':        ['학원', '고등학생', '대학생', '동아리', '학생', '교복', '입시', '학창시절', '선후배'],
        '오피스':      ['오피스', '직장', '직장인', '비서', '사장', 'ceo', '스타트업', '인턴', '승진'],
        '사극·무협':   ['사극', '무협', '조선', '궁중', '왕세자', '검객', '문파', '내공', '기생', '양반', '사도'],
        'SF·근미래':   ['sf', '근미래', '사이버펑크', '안드로이드', '로봇', '인공지능', '초인류', '클론', '증강현실'],
        '호러·스릴러': ['호러', '공포', '스릴러', '괴담', '살인', '추격', '귀신', '심령', '저주', '광기극'],
        '일상·힐링':   ['일상', '힐링', '슬라이스', '카페', '소소', '동네', '반려동물'],
        '미스터리':    ['미스터리', '추리', '탐정', '사건', '단서', '실종', '수사', '알리바이'],
        '아이돌·연예': ['아이돌', '연예인', '배우', '매니저', '데뷔', '무대', '연습생', '팬미팅', '소속사'],
        '오메가버스':  ['오메가버스', '알파', '오메가', '베타', '페로몬', '각인'],
        '뱀파이어·오컬트': ['뱀파이어', '흡혈귀', '늑대인간', '악마', '천사', '퇴마', '오컬트', '마녀', '계약자'],
        '범죄·느와르': ['범죄', '조직', '마피아', '갱', '보스급', '암살자', '청부', '밀수', '카르텔'],
        '군상·성장':   ['성장', '군상극', '재기', '도전', '슬럼프', '재활']
      }
    },
    relation: {
      label: '관계',
      values: {
        '짝사랑':    ['짝사랑', '외사랑', '고백', '혼자만의', '애타는'],
        '소꿉친구':  ['소꿉친구', '어릴적친구', '동네친구', '남사친', '여사친', '불알친구'],
        '계약관계':  ['계약', '거래', '위장결혼', '가짜연인', '결혼계약', '거래관계', '조건만남'],
        '상사·부하': ['상사', '부하', '직속', '사수', '팀장', '부장', '실장', '비서실'],
        '사제':      ['선생', '교사', '제자', '스승', '과외', '교수', '조교', '멘토'],
        '라이벌':    ['라이벌', '경쟁', '숙적', '대결', '맞수'],
        '원수·적대': ['원수', '적대', '복수', '배신', '증오', '앙숙', '대립'],
        '재회':      ['재회', '전남친', '전여친', '옛사랑', '다시만난', '헤어졌던'],
        '동거':      ['동거', '룸메', '한집살이', '하숙', '셰어하우스'],
        '주종':      ['주인', '집사', '하인', '기사', '주종', '시종', '메이드'],
        '첫사랑':    ['첫사랑', '오래된마음', '초등학교때'],
        '금지된관계':['금지된', '이루어질수없는', '비밀연애', '위험한관계', '불가능한'],
        '삼각관계':  ['삼각관계', '사각관계', '경쟁자', '양다리'],
        '부부·연인': ['부부', '남편', '아내', '결혼생활', '오래된연인', '권태기'],
        '가족':      ['남매', '형제', '자매', '의붓', '입양', '사촌', '보호자'],
        '팬·스타':   ['팬', '스타', '덕질', '최애', '사생'],
        '구원':      ['구원', '치유자', '손내밀', '끌어올린'],
        '스토커':    ['스토커', '추적자', '감시자']
      }
    },
    tone: {
      label: '정서',
      values: {
        '달달':  ['달달', '설렘', '풋풋', '따뜻', '심쿵', '꿀', '알콩달콩'],
        '다크':  ['다크', '느와르', '음울', '잔혹', '어두운', '피폐', '파멸적'],
        '코믹':  ['코믹', '개그', '유머', '웃긴', '병맛', '드립', '유쾌'],
        '집착':  ['집착', '광기', '소유욕', '감금', '독점욕', '병적'],
        '애절':  ['애절', '슬픔', '눈물', '이별', '비극', '먹먹', '애틋', '절절'],
        '치유':  ['치유', '위로', '포근', '따스함', '안식', '다독'],
        '자극':  ['자극', '긴장', '스릴', '아슬', '숨막히는', '아찔'],
        '잔잔':  ['잔잔', '담백', '차분', '고요', '나른'],
        '몽환':  ['몽환', '환상적', '아득', '초현실', '꿈결'],
        '절망':  ['절망', '무력', '체념', '나락', '바닥'],
        '희망':  ['희망', '빛', '일어서는', '앞으로'],
        '서정':  ['서정', '감성', '아련', '노스탤지어', '회상']
      }
    },
    setting: {
      label: '배경',
      values: {
        '현대':       ['현대', '도시', '서울', '현실', '번화가'],
        '이세계':     ['이세계', '전생', '환생', '차원', '왕국', '제국', '던전'],
        '아포칼립스': ['아포칼립스', '종말', '좀비', '폐허', '생존', '방공호', '역병'],
        '근미래도시': ['메가시티', '가상현실', '디스토피아', '슬럼가'],
        '사극배경':   ['궁', '궁궐', '한양', '무림', '객잔', '기방'],
        '학교':       ['교실', '기숙사', '학교', '캠퍼스', '옥상', '도서관'],
        '회사':       ['사무실', '회사', '사내', '오피스텔', '회의실', '탕비실'],
        '우주':       ['우주', '함선', '행성', '스테이션', '은하'],
        '병원':       ['병원', '응급실', '요양원', '진료실', '수술실'],
        '지방·시골':  ['시골', '바닷가', '섬마을', '산골', '읍내'],
        '밤거리':     ['밤거리', '바', '클럽', '술집', '포차', '뒷골목'],
        '숙소':       ['호텔', '펜션', '리조트', '민박', '별장'],
        '폐쇄공간':   ['감옥', '지하실', '밀실', '엘리베이터', '고립']
      }
    },
    archetype: {
      label: '캐릭터',
      values: {
        '츤데레':     ['츤데레', '까칠', '퉁명', '삐딱', '새침'],
        '얀데레':     ['얀데레', '집착남', '집착녀', '광기남', '광기녀'],
        '다정':       ['다정', '상냥', '자상', '온화', '부드러운', '배려심'],
        '카리스마':   ['카리스마', '냉철', '보스', '재벌', '대표', '군주', '지배적'],
        '순정':       ['순정', '순수', '순박', '해맑', '천진'],
        '능글':       ['능글', '느끼', '유혹', '플러팅', '작업', '뻔뻔'],
        '무심':       ['무심', '무뚝뚝', '무표정', '건조', '시크', '심드렁'],
        '열혈':       ['열혈', '패기', '직진', '저돌', '열정'],
        '미스터리한': ['정체불명', '비밀', '수수께끼', '베일', '속을알수없는'],
        '소심':       ['소심', '내성적', '수줍', '숫기없는', '조심스러운'],
        '도도':       ['도도', '고고', '자존심', '콧대'],
        '천재':       ['천재', '수재', '영재', '엘리트', '완벽주의'],
        '반항아':     ['반항', '불량', '일진', '문제아', '자유분방'],
        '어른스러운': ['어른스러운', '든든', '성숙', '믿음직'],
        '허당':       ['허당', '푼수', '엉뚱', '4차원', '백치미']
      }
    }
  };

  var AXIS_KEYS = Object.keys(TAXONOMY);

  /**
   * 키워드 → [{axis, value}] 역색인.
   * 매 작품마다 사전 전체를 순회하지 않기 위해 한 번만 만들어 캐시한다.
   */
  function buildIndex(taxonomy) {
    var index = {};
    Object.keys(taxonomy).forEach(function (axis) {
      var values = taxonomy[axis].values;
      Object.keys(values).forEach(function (value) {
        values[value].forEach(function (kw) {
          var k = String(kw).toLowerCase().trim();
          (index[k] = index[k] || []).push({ axis: axis, value: value });
        });
      });
    });
    return index;
  }

  /** 같은 키워드가 두 축에 걸쳐 있으면 동어반복 조합의 원인이 된다 */
  function validateTaxonomy(taxonomy) {
    var index = buildIndex(taxonomy);
    var collisions = [];
    Object.keys(index).forEach(function (kw) {
      var axes = {};
      index[kw].forEach(function (e) { axes[e.axis] = true; });
      if (Object.keys(axes).length > 1) {
        collisions.push({ keyword: kw, axes: Object.keys(axes) });
      }
    });
    return collisions;
  }

  var DEFAULT_INDEX = buildIndex(TAXONOMY);

  /* ===========================================================================
   * 2. 기본 옵션
   * ========================================================================= */
  var DEFAULTS = {
    now: null,              // 기준 시각(테스트 재현용). null → Date.now()
    recentDays: 90,         // "최근작" 판정 기준
    minSupport: 5,          // 이 미만 표본은 잠정(provisional) 처리
    priorStrength: 8,       // 베이지안 축소 강도 k (클수록 보수적)
    sampling: 'census',     // 'census' 전수 | 'ranked' 인기순 상위만 수집(생존편향)
    topN: 8,
    redundancyThreshold: 0.65,  // 자카드 중복도가 이 이상이면 정보량 없는 조합으로 간주

    seed: 12345,            // 부트스트랩 난수 시드 — 결과 재현성을 위해 고정
    bootstrapSamples: 200,  // 신뢰구간 재표본 횟수 (0 이면 CI 계산 생략)
    conservative: false,    // true → gap 의 신뢰구간 하한으로 순위를 매긴다
    robustnessTrials: 300,  // 가중치 민감도 시행 횟수 (0 이면 생략)
    explain: true,          // 추천에 셀 심층 해설을 포함할지
    diversity: 0.45,        // 추천 다양성 λ (0 이면 점수순 그대로)
    cohortDays: 90,         // 코호트 한 칸의 기간
    cohortCount: 4,         // 코호트 개수 (가장 오래된 칸은 열린 구간)
    myWorks: null,          // 내 작품 배열 → 제작자 적합도 계산

    comboAxes: [            // 교차 분석할 축 쌍
      ['genre', 'relation'],
      ['genre', 'tone'],
      ['setting', 'genre'],
      ['relation', 'archetype'],
      ['tone', 'archetype']
    ],
    tripleAxes: [           // 3축 조합 — 실제 "주제" 에 가장 가까운 단위
      ['genre', 'relation', 'tone'],
      ['setting', 'genre', 'archetype']
    ],
    weights: {
      gap:       0.28,      // 수요/공급 불균형
      momentum:  0.15,      // 신작 성과 수준
      trend:     0.12,      // 코호트별 점유율 추세(방향)
      openness:  0.13,      // 비독점도 (1 - 집중도)
      newcomer:  0.10,      // 신인 제작자 성공률
      quality:   0.09,      // 좋아요/대화 = 만족도
      staleness: 0.08,      // 노후도 = 리프레시 여지
      fit:       0.05       // 제작자 적합도 (myWorks 없으면 전 셀 1.0 → 순위 영향 없음)
    }
  };

  /* ===========================================================================
   * 3. 수치 유틸
   * ========================================================================= */
  var DAY = 86400000;

  /** 점수를 구성하는 지표 — 가중치 키와 백분위 키가 항상 일치해야 한다 */
  var SCORE_KEYS = ['gap', 'momentum', 'trend', 'openness', 'newcomer', 'quality', 'staleness', 'fit'];

  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : (fallback || 0);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /**
   * 백분위 변환 (0~1). 동점은 평균 순위로 처리한다.
   * 롱테일 분포에서 z-score 보다 이상치에 강건하다.
   */
  function percentileRank(values) {
    var n = values.length;
    if (n === 0) return [];
    if (n === 1) return [0.5];

    var idx = values.map(function (v, i) { return { v: v, i: i }; });
    idx.sort(function (a, b) { return a.v - b.v; });

    var out = new Array(n);
    var r = 0;
    while (r < n) {
      var j = r;
      while (j + 1 < n && idx[j + 1].v === idx[r].v) j++;   // 동점 구간
      var avgRank = (r + j) / 2;
      for (var k = r; k <= j; k++) out[idx[k].i] = avgRank / (n - 1);
      r = j + 1;
    }
    return out;
  }

  /**
   * 베이지안 축소 — 표본이 적을수록 값을 prior(중립값)로 끌어당긴다.
   * 이 엔진에서 가장 중요한 보정. 작품 2개짜리 셀의 극단적 비율을 무력화한다.
   */
  function shrink(value, n, k, prior) {
    var p = (prior === undefined) ? 1 : prior;
    if (!isFinite(value)) return p;
    return (n * value + k * p) / (n + k);
  }

  /** 시드 고정 선형합동 난수 — 부트스트랩 결과를 재현 가능하게 만든다 */
  function makeRandom(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /**
   * 부트스트랩 신뢰구간 — 점수를 "정밀한 값" 으로 착각하지 않기 위한 장치.
   *
   * gap = 셀 평균 수요 / 전체 평균 수요 이므로, 셀 구성원을 복원추출로 재표본하여
   * gap 의 분포를 만든다. 작품 6개짜리 셀의 gap 1.6 은 신뢰구간이 [0.9, 2.6] 처럼
   * 넓게 나오고, 20개짜리 셀의 gap 1.4 는 [1.2, 1.7] 로 좁게 나온다.
   * 같은 자릿수로 나란히 보이던 두 숫자가 실제로는 전혀 다른 무게였음을 드러낸다.
   */
  function bootstrapGapCI(members, globalMeanDemand, opt, rand) {
    var B = opt.bootstrapSamples;
    var n = members.length;
    if (!B || n === 0 || globalMeanDemand <= 0) return null;

    var gaps = new Array(B);
    for (var b = 0; b < B; b++) {
      var wSum = 0, dSum = 0;
      for (var i = 0; i < n; i++) {
        var m = members[(rand() * n) | 0];
        wSum += m.weight;
        dSum += m.weight * m.work.demand;
      }
      var mean = wSum > 0 ? dSum / wSum : 0;
      // 점추정과 동일한 축소를 적용해야 CI 와 점추정이 같은 척도에 놓인다
      gaps[b] = shrink(mean / globalMeanDemand, n, opt.priorStrength, 1);
    }
    gaps.sort(function (a, b2) { return a - b2; });
    return {
      lo: gaps[Math.floor(B * 0.025)],
      hi: gaps[Math.min(B - 1, Math.floor(B * 0.975))]
    };
  }

  /** 단순 선형회귀 기울기 — 코호트 추세 계산용 */
  function linregSlope(points) {
    var n = points.length;
    if (n < 2) return 0;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    points.forEach(function (p) {
      sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y;
    });
    var d = n * sxx - sx * sx;
    return d === 0 ? 0 : (n * sxy - sx * sy) / d;
  }

  /* ===========================================================================
   * 4. 분류 — 원시 태그 → 축 값
   * ========================================================================= */
  /**
   * 작품 하나를 축별 값 배열로 분류한다.
   *
   * 태그는 **완전 일치**, 제목은 부분 일치로 본다.
   * 태그에 부분 일치를 쓰면 '집착남'(캐릭터:얀데레) 태그가 '집착'(정서) 키워드에도
   * 걸려 두 축이 항상 함께 켜지고, 그 결과 "집착 × 얀데레" 같은 동어반복이 생긴다.
   * 태그 어휘는 유한하므로 사전을 채우는 편이 정확하고, 누락분은
   * unmappedTags 로 보고되어 사전을 보강할 수 있다.
   *
   * work.axes 가 있으면 수동 라벨을 우선한다.
   */
  function classify(work, taxonomy) {
    var index = taxonomy ? buildIndex(taxonomy) : DEFAULT_INDEX;
    var result = {};
    var matched = {};                       // 사전에 걸린 태그 기록(미분류 집계용)
    var hits = {};                          // axis → { value: true }

    AXIS_KEYS.forEach(function (a) { hits[a] = {}; });

    var tags = (work.tags || []).map(function (t) { return String(t).toLowerCase().trim(); })
                                .filter(Boolean);

    // 1) 태그 — 완전 일치
    tags.forEach(function (tag) {
      var entries = index[tag];
      if (!entries) return;
      matched[tag] = true;
      entries.forEach(function (e) { hits[e.axis][e.value] = true; });
    });

    // 2) 제목 — 부분 일치 (태그가 부실한 데이터의 보조 신호)
    var title = String(work.title || '').toLowerCase();
    if (title) {
      Object.keys(index).forEach(function (kw) {
        if (kw.length >= 2 && title.indexOf(kw) !== -1) {
          index[kw].forEach(function (e) { hits[e.axis][e.value] = true; });
        }
      });
    }

    AXIS_KEYS.forEach(function (axis) {
      if (work.axes && Array.isArray(work.axes[axis]) && work.axes[axis].length) {
        result[axis] = work.axes[axis].slice();       // 수동 라벨 우선
      } else {
        result[axis] = Object.keys(hits[axis]);
      }
    });

    return { axes: result, matchedTags: matched, tags: tags };
  }

  /* ===========================================================================
   * 5. 정규화 — 작품별 수요 지표 계산
   * ========================================================================= */
  /**
   * 작품별 수요 지표.
   *
   * 수요 가중치로는 **윈저화한 일평균 대화수(velocity)** 를 쓴다.
   *  · 누적 대화수는 나이의 함수라 오래된 작품이 구조적으로 이긴다.
   *  · 로그를 씌우면 측정하려던 인기 격차 자체가 뭉개진다.
   *    (초기 버전이 그랬고, 그 결과 모든 gap 이 0.95~1.11 에 몰려
   *     수요/공급 불균형을 전혀 구분하지 못했다)
   *  · 대신 상위 p95 에서 잘라 초대형 히트작 하나가 셀 전체를
   *    좌우하는 문제를 막는다. 로그보다 해석이 쉽다 — gap 2.0 은 곧
   *    "공급 비중 대비 실수요가 2배" 를 뜻한다.
   */
  function normalizeWorks(rawWorks, opt) {
    var now = opt.now || Date.now();
    var unmapped = {};

    var works = rawWorks.map(function (w, i) {
      var created = w.createdAt ? new Date(w.createdAt).getTime() : (now - 180 * DAY);
      if (!isFinite(created)) created = now - 180 * DAY;

      var ageDays = Math.max(1, (now - created) / DAY);
      var chats   = Math.max(0, num(w.chats));
      var likes   = Math.max(0, num(w.likes));
      var velocity = chats / ageDays;                    // 일평균 대화수
      var quality = chats > 0 ? likes / chats : 0;       // 대화당 좋아요 = 만족도 대리

      var c = classify(w, opt.taxonomy);

      // 어떤 축에도 걸리지 않은 태그 수집 → 사전 개선용
      c.tags.forEach(function (t) {
        if (!c.matchedTags[t]) unmapped[t] = (unmapped[t] || 0) + 1;
      });

      return {
        id: w.id || ('w' + i),
        title: w.title || '(무제)',
        tags: c.tags,
        axes: c.axes,
        createdAt: created,
        ageDays: ageDays,
        isRecent: ageDays <= opt.recentDays,
        chats: chats,
        likes: likes,
        velocity: velocity,
        followers: Math.max(0, num(w.creatorFollowers)),
        // 수집 출처 — 표본 편향 판정에 쓴다 (없으면 unknown)
        source: String(w.source || 'unknown'),
        rank: w.rank != null ? num(w.rank) : null,
        demand: velocity,          // 아래에서 윈저화로 덮어씀
        quality: quality,
        // 코호트 인덱스: 0 = 가장 오래된 칸(열린 구간), 마지막 = 최신
        cohort: clamp(
          opt.cohortCount - 1 - Math.floor(ageDays / opt.cohortDays),
          0, opt.cohortCount - 1)
      };
    });

    // 윈저화 — 상위 5% 를 p95 값으로 절단해 초대형 히트작의 지배를 막는다
    var sorted = works.map(function (w) { return w.velocity; })
                      .sort(function (a, b) { return a - b; });
    var cap = sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
      : 0;
    works.forEach(function (w) { w.demand = Math.min(w.velocity, cap); });

    var unmappedList = Object.keys(unmapped)
      .map(function (t) { return { tag: t, count: unmapped[t] }; })
      .sort(function (a, b) { return b.count - a.count; });

    return { works: works, unmappedTags: unmappedList };
  }

  /* ===========================================================================
   * 6. 셀 집계
   * ========================================================================= */
  /**
   * 하나의 셀(= 축 값 또는 축 값 조합)에 대한 원시 통계를 만든다.
   * members: [{ work, weight }] — weight 는 다중 라벨 분할 가중치.
   */
  function buildCellStats(members, ctx) {
    var n = 0, demandSum = 0;
    var demands = [], velocities = [], qualities = [], ages = [];
    var recentVel = [];
    var oldCount = 0;
    var ids = {};
    var newcomerTotal = 0, newcomerHit = 0;
    var cohortDemand = [];
    for (var ci = 0; ci < ctx.cohortCount; ci++) cohortDemand.push(0);

    members.forEach(function (m) {
      var w = m.work;
      n += m.weight;
      demandSum += m.weight * w.demand;
      cohortDemand[w.cohort] += m.weight * w.demand;
      demands.push(w.demand);
      velocities.push(w.velocity);
      qualities.push(w.quality);
      ages.push(w.ageDays);
      ids[w.id] = true;
      if (w.isRecent) recentVel.push(w.velocity); else oldCount++;
      if (w.followers <= ctx.followerMedian) {
        newcomerTotal++;
        if (w.velocity >= ctx.velocityMedian) newcomerHit++;   // 신인이 평균 이상 성과
      }
    });

    // 수요 집중도(HHI) — 셀 내부에서 상위 작품이 수요를 독식하는 정도
    var hhi = 0, topShare = 0;
    if (demandSum > 0) {
      members.forEach(function (m) {
        var s = (m.weight * m.work.demand) / demandSum;
        hhi += s * s;
        if (s > topShare) topShare = s;
      });
    }

    return {
      count: members.length,
      n: n,
      demandSum: demandSum,
      medianDemand: median(demands),
      medianVelocity: median(velocities),
      medianQuality: median(qualities),
      medianAge: median(ages),
      recentCount: recentVel.length,
      oldCount: oldCount,
      ids: ids,
      cohortDemand: cohortDemand,
      recentMedianVelocity: recentVel.length ? median(recentVel) : 0,
      hhi: hhi,
      topShare: topShare,
      newcomerRate: newcomerTotal ? newcomerHit / newcomerTotal : 0,
      newcomerTotal: newcomerTotal,
      members: members
    };
  }

  /**
   * 축 하나에 대해 값별 셀을 만든다.
   * 다중 라벨 작품은 1/n 로 분할해 공급 총량이 부풀지 않게 한다.
   */
  function groupByAxis(works, axis) {
    var groups = {};
    works.forEach(function (w) {
      var vals = w.axes[axis] || [];
      if (!vals.length) return;
      var weight = 1 / vals.length;
      vals.forEach(function (v) {
        (groups[v] = groups[v] || []).push({ work: w, weight: weight });
      });
    });
    return groups;
  }

  /** 두 축의 교차 셀 */
  function groupByPair(works, axisA, axisB) {
    var groups = {};
    works.forEach(function (w) {
      var A = w.axes[axisA] || [], B = w.axes[axisB] || [];
      if (!A.length || !B.length) return;
      var weight = 1 / (A.length * B.length);
      A.forEach(function (a) {
        B.forEach(function (b) {
          var key = a + ' × ' + b;
          (groups[key] = groups[key] || { a: a, b: b, members: [] })
            .members.push({ work: w, weight: weight });
        });
      });
    });
    return groups;
  }

  /** 세 축의 교차 셀 — 실제 "주제" 에 가장 가까운 단위 */
  function groupByTriple(works, ax) {
    var groups = {};
    works.forEach(function (w) {
      var A = w.axes[ax[0]] || [], B = w.axes[ax[1]] || [], C = w.axes[ax[2]] || [];
      if (!A.length || !B.length || !C.length) return;
      var weight = 1 / (A.length * B.length * C.length);
      A.forEach(function (a) {
        B.forEach(function (b) {
          C.forEach(function (c) {
            var key = a + ' × ' + b + ' × ' + c;
            if (!groups[key]) groups[key] = { values: [a, b, c], members: [] };
            groups[key].members.push({ work: w, weight: weight });
          });
        });
      });
    });
    return groups;
  }

  /* ===========================================================================
   * 7. 점수화
   * ========================================================================= */
  /**
   * 1단계: 원시 지표 계산.
   *
   * share/gap 은 반드시 자기 그룹(같은 축 또는 같은 축 쌍) 총량 기준으로 계산한다.
   * 장르 축의 공급 비중을 정서 축 총량으로 나누면 의미가 없기 때문이다.
   */
  function computeCellMetrics(cells, totals, opt, rand) {
    if (!cells.length) return [];

    var k = opt.priorStrength;
    var globalMeanDemand = totals.n > 0 ? totals.demand / totals.n : 0;
    var globalNewcomer = totals.globalNewcomerRate;
    var globalQuality  = totals.globalQuality || 1e-9;
    var globalRecentVel = totals.globalRecentVelocity || 1e-9;

    cells.forEach(function (c) {
      var s = c.stats;

      c.supplyShare = totals.n > 0 ? s.n / totals.n : 0;
      c.demandShare = totals.demand > 0 ? s.demandSum / totals.demand : 0;

      // (1) 수요/공급 불균형 — 1 초과면 수요가 공급을 앞선다
      var rawGap = c.supplyShare > 0 ? c.demandShare / c.supplyShare : 1;
      c.gapRaw = rawGap;
      c.gap = shrink(rawGap, s.count, k, 1);

      // 인기순 상위만 수집한 데이터는 실패작이 보이지 않아 gap 이 부풀려진다.
      // 보수적으로 중립 쪽으로 절반 당긴다.
      if (opt.sampling === 'ranked') c.gap = 1 + (c.gap - 1) * 0.5;

      // (1-b) gap 의 신뢰구간 — 표본이 적은 셀의 점수를 곧이곧대로 믿지 않기 위해
      var ci = rand ? bootstrapGapCI(s.members, globalMeanDemand, opt, rand) : null;
      if (ci && opt.sampling === 'ranked') {
        ci = { lo: 1 + (ci.lo - 1) * 0.5, hi: 1 + (ci.hi - 1) * 0.5 };
      }
      c.gapLo = ci ? ci.lo : c.gap;
      c.gapHi = ci ? ci.hi : c.gap;
      // 신뢰구간이 1 을 넘지 않으면 "수요 초과" 라고 말할 근거가 없다
      c.significant = ci ? (ci.lo > 1 || ci.hi < 1) : false;

      // (1-c) 코호트 추세 — 시간에 따라 이 셀의 수요 점유율이 오르는가 내리는가.
      // 코호트 안에서 점유율을 계산하므로 velocity 가 나이에 따라 감소하는
      // 체계적 편향이 분자·분모에 동일하게 걸려 상쇄된다.
      var pts = [];
      for (var ci2 = 0; ci2 < totals.cohortTotals.length; ci2++) {
        var denom = totals.cohortTotals[ci2];
        if (denom > 0) pts.push({ x: ci2, y: s.cohortDemand[ci2] / denom });
      }
      var meanShare = pts.length
        ? pts.reduce(function (a, p) { return a + p.y; }, 0) / pts.length : 0;
      var slope = linregSlope(pts);
      // 점유율 규모로 나눠 상대 변화율로 만든다(작은 셀도 큰 셀과 비교 가능)
      var relSlope = meanShare > 0 ? slope / meanShare : 0;
      c.trend = shrink(1 + relSlope, s.count, k, 1);
      c.trendLabel = c.trend > 1.15 ? 'rising' : (c.trend < 0.85 ? 'declining' : 'stable');

      // (2) 모멘텀 — 최근작의 성과가 전체 최근작 중앙값 대비 어떤가
      var rawMomentum = s.recentCount ? (s.recentMedianVelocity / globalRecentVel) : 1;
      c.momentum = shrink(rawMomentum, s.recentCount, k / 2, 1);

      // (3) 개방도 — 집중도(HHI)의 역
      c.openness = 1 - clamp(s.hhi, 0, 1);

      // (4) 신인 성공률
      c.newcomer = shrink(s.newcomerRate, s.newcomerTotal, k / 2, globalNewcomer);

      // (5) 만족도
      c.quality = shrink(s.medianQuality / globalQuality, s.count, k, 1);

      // (6) 노후도 — 오래된 카테고리일수록 리프레시 여지
      c.staleness = s.medianAge;

      // (참고 지표) 공급 쏠림 — 제작자가 최근 이 셀로 몰리는 정도.
      // 점수에는 넣지 않고 경쟁 심화 리스크 판정에만 쓴다.
      var recentShare = totals.recentCount ? s.recentCount / totals.recentCount : 0;
      var oldShare    = totals.oldCount    ? s.oldCount    / totals.oldCount    : 0;
      c.supplyRush = oldShare > 0
        ? shrink(recentShare / oldShare, s.recentCount, k / 2, 1)
        : 1;

      // (7) 제작자 적합도 — 내 작품이 이 축 값들에서 평균 이상이었는가
      c.fit = totals.fitOf ? totals.fitOf(c) : 1;
    });

    return cells;
  }

  /* ===========================================================================
   * 7-b. 제작자 적합도
   * ========================================================================= */
  /**
   * 내가 만든 작품들의 축 값별 상대 성과를 계산한다.
   *
   * "시장에 기회가 있는 주제" 와 "내가 잘 만드는 주제" 는 다른 질문이다.
   * 내 작품 표본은 대개 10개 미만이라 노이즈가 크므로 축소 강도를 세게(k=3) 준다.
   * myWorks 가 없으면 모든 셀이 1.0 을 받아 순위에 영향을 주지 않는다.
   */
  function buildFitIndex(marketWorks, myWorks) {
    if (!myWorks || !myWorks.length) return null;

    var index = {};
    AXIS_KEYS.forEach(function (axis) {
      var marketGroups = groupByAxis(marketWorks, axis);
      var mineGroups   = groupByAxis(myWorks, axis);

      Object.keys(mineGroups).forEach(function (value) {
        var mine = mineGroups[value].map(function (m) { return m.work.velocity; });
        var market = (marketGroups[value] || []).map(function (m) { return m.work.velocity; });
        var marketMed = median(market);
        if (marketMed <= 0) return;
        index[axis + '|' + value] = {
          ratio: shrink(median(mine) / marketMed, mine.length, 3, 1),
          n: mine.length
        };
      });
    });
    return index;
  }

  /** 셀이 가진 축 값들의 적합도 평균 (기록 없는 값은 중립 1.0) */
  function makeFitResolver(index) {
    if (!index) return null;
    return function (cell) {
      var axes = cell.kind === 'axis' ? [cell.axis] : cell.axes;
      var values = cell.kind === 'axis' ? [cell.value] : cell.values;
      var sum = 0;
      axes.forEach(function (ax, i) {
        var e = index[ax + '|' + values[i]];
        sum += e ? e.ratio : 1;
      });
      return axes.length ? sum / axes.length : 1;
    };
  }

  /**
   * 2단계: 백분위 정규화 + 가중합.
   *
   * 반드시 "서로 비교될 셀 전체" 를 한 번에 넘겨야 한다.
   * 축 쌍별로 따로 정규화하면 그룹마다 1위가 p=1 을 받아 병합 랭킹이 무의미해지고,
   * 축이 다른 셀의 점수를 곱하는 whitespace 계산도 성립하지 않는다.
   */
  function finalizeScores(cells, opt) {
    if (!cells.length) return [];

    // conservative 모드에서는 gap 의 신뢰구간 하한으로 순위를 매긴다.
    // "가장 좋아 보이는 셀" 이 아니라 "나쁠 리 없는 셀" 을 고르는 방식이며,
    // 표본이 적어 CI 가 넓은 셀은 자동으로 뒤로 밀린다.
    var gapMetric = opt.conservative
      ? cells.map(function (c) { return c.gapLo; })
      : cells.map(function (c) { return c.gap; });

    // 백분위 정규화
    var pct = {
      gap:       percentileRank(gapMetric),
      momentum:  percentileRank(cells.map(function (c) { return c.momentum; })),
      trend:     percentileRank(cells.map(function (c) { return c.trend; })),
      openness:  percentileRank(cells.map(function (c) { return c.openness; })),
      newcomer:  percentileRank(cells.map(function (c) { return c.newcomer; })),
      quality:   percentileRank(cells.map(function (c) { return c.quality; })),
      staleness: percentileRank(cells.map(function (c) { return c.staleness; })),
      fit:       percentileRank(cells.map(function (c) { return c.fit; }))
    };

    var w = opt.weights;
    var KEYS = SCORE_KEYS;

    cells.forEach(function (c, i) {
      c.p = {};
      KEYS.forEach(function (key) { c.p[key] = pct[key][i]; });

      var sum = 0, wTotal = 0;
      KEYS.forEach(function (key) {
        var weight = num(w[key], 0);
        sum += weight * c.p[key];
        wTotal += weight;
      });

      c.score = 100 * (sum / (wTotal || 1));

      // 표본 부족 셀은 잠정 처리 + 점수 감쇠
      c.provisional = c.stats.count < opt.minSupport;
      if (c.provisional) c.score *= 0.85;

      c.risks = buildRisks(c, opt);
    });

    return cells.sort(function (a, b) { return b.score - a.score; });
  }

  /** 셀별 리스크 플래그 */
  function buildRisks(c, opt) {
    var r = [];
    var s = c.stats;
    if (c.provisional)        r.push({ code: 'SMALL_SAMPLE', label: '표본 부족 (' + s.count + '개)' });
    if (s.hhi > 0.5)          r.push({ code: 'WINNER_TAKE_ALL', label: '상위 독식 구조' });
    if (s.topShare > 0.6)     r.push({ code: 'TOP_HEAVY', label: '1개 작품이 수요 대부분 차지' });
    if (c.momentum < 0.8)     r.push({ code: 'DECLINING', label: '최근작 성과 하락' });
    if (c.trendLabel === 'declining')
                              r.push({ code: 'SHRINKING', label: '수요 점유율 하락 추세' });
    if (c.gapLo !== undefined && c.gapHi !== undefined && (c.gapHi - c.gapLo) > 0.8)
                              r.push({ code: 'WIDE_CI', label: '추정 불확실 (신뢰구간 넓음)' });
    if (c.p && c.p.staleness > 0.85 && c.momentum < 1)
                              r.push({ code: 'STALE', label: '신작 유입 정체' });
    if (c.gap < 0.85 && c.supplyShare > 0.08)
                              r.push({ code: 'OVERSUPPLIED', label: '공급 과잉 (레드오션)' });
    if (c.supplyRush > 1.6)   r.push({ code: 'CROWDING', label: '최근 신작 유입 급증 (경쟁 심화)' });
    if (c.tautology)          r.push({ code: 'REDUNDANT', label: '단일 축 대비 추가 정보 없음' });
    return r;
  }

  /**
   * 자카드 중복도 — 두 축 값이 같은 작품군을 가리키는 정도.
   *
   * 사전을 정리해도 데이터 차원의 중복은 남는다. 제작자들이 '오피스'(장르)와
   * '회사'(배경)를 늘 함께 붙이면 두 셀의 작품 집합이 거의 같아진다.
   *
   * 주의: 이 지표는 개념적 동의어('집착'/'얀데레')와 단순 동시출현
   * ('학원'/'짝사랑')을 구분하지 못한다. 구분할 필요도 없다 — 조합 추천의
   * 관점에서 둘 다 "단일 축 대비 추가 정보가 없는 조합" 이고, 별개의 선택지가
   * 아니기 때문이다. 해당 축은 단일 축 랭킹에 이미 나와 있다.
   */
  function jaccard(idsA, idsB) {
    var a = Object.keys(idsA), b = Object.keys(idsB);
    if (!a.length || !b.length) return 0;
    var inter = 0;
    a.forEach(function (id) { if (idsB[id]) inter++; });
    var union = a.length + b.length - inter;
    return union > 0 ? inter / union : 0;
  }

  /* ===========================================================================
   * 7-c. 다양성 기반 선별 (Maximal Marginal Relevance)
   * ========================================================================= */
  /**
   * 점수 상위 N개를 그대로 뽑으면 추천이 한 덩어리로 쏠린다.
   * "오피스 × 집착", "오피스 × 상사·부하", "상사·부하 × 얀데레" 는 사실상
   * 하나의 선택지이지 여덟 개의 선택지가 아니다.
   *
   * 매 단계에서 (점수 − λ · 이미 뽑은 것과의 최대 유사도) 가 가장 큰 항목을 고른다.
   * λ=0 이면 순수 점수순, 값이 클수록 서로 다른 영역을 강제로 섞는다.
   */
  function selectDiverse(cells, n, lambda) {
    if (lambda <= 0) return cells.slice(0, n);

    var pool = cells.slice();
    var picked = [];

    while (picked.length < n && pool.length) {
      var bestIdx = 0, bestVal = -Infinity;
      pool.forEach(function (c, i) {
        var maxSim = 0;
        picked.forEach(function (p) {
          var sim = cellSimilarity(c, p);
          if (sim > maxSim) maxSim = sim;
        });
        var val = (c.score / 100) - lambda * maxSim;
        if (val > bestVal) { bestVal = val; bestIdx = i; }
      });
      picked.push(pool.splice(bestIdx, 1)[0]);
    }
    return picked;
  }

  /** 두 셀의 유사도 — 공유하는 축 값 비율과 작품 집합 중복도의 혼합 */
  function cellSimilarity(a, b) {
    var va = a.kind === 'axis' ? [a.value] : a.values;
    var vb = b.kind === 'axis' ? [b.value] : b.values;
    var shared = 0;
    va.forEach(function (v) { if (vb.indexOf(v) >= 0) shared++; });
    var valueSim = shared / Math.min(va.length, vb.length);
    var memberSim = jaccard(a.stats.ids, b.stats.ids);
    return 0.6 * valueSim + 0.4 * memberSim;
  }

  /* ===========================================================================
   * 7-d. 셀 심층 해설 (drill-down)
   * ========================================================================= */
  /**
   * "이 조합은 78점" 만으로는 무엇을 만들지 알 수 없다.
   * 셀 안을 열어 실제로 쓸 수 있는 정보를 뽑는다.
   *
   *  · 성과 분포   — 중앙값 작품이 실제로 어느 정도 성적인지(평균은 히트작에 왜곡됨)
   *  · 상·하위 작품 — 대표 사례
   *  · 승패 태그   — 같은 셀 안에서 상위권에만 붙는 태그 / 하위권에만 붙는 태그
   *  · 동반 태그   — 이 조합에 통상 함께 붙는 태그
   *  · 연령 구성   — 성과가 최근 것인지 과거 유산인지
   *
   * 승패 태그가 이 함수의 핵심이다. "오피스 × 집착을 만들라" 보다
   * "그 안에서 상위권은 재벌·비서를 함께 달았고 하위권은 그렇지 않다" 가 훨씬 실행 가능하다.
   */
  function explainCell(cell, opt) {
    var members = cell.stats.members;
    if (!members || !members.length) return null;

    var works = members.map(function (m) { return m.work; });
    var vels = works.map(function (w) { return w.velocity; })
                    .sort(function (a, b) { return a - b; });

    var q = function (p) {
      if (!vels.length) return 0;
      return vels[Math.min(vels.length - 1, Math.floor(vels.length * p))];
    };

    var sorted = works.slice().sort(function (a, b) { return b.velocity - a.velocity; });
    var half = Math.max(1, Math.floor(sorted.length / 2));
    var top = sorted.slice(0, half);
    var bottom = sorted.slice(-half);

    // 셀을 정의하는 값들. 원시 태그가 이 값으로 분류되면 동반/승패 태그에서 빼야 한다.
    // 값 이름만 비교하면 안 된다 — 셀 값은 '상사·부하' 인데 태그는 '상사' 라서
    // 이름 비교로는 걸러지지 않고 "동반 태그 상사 100%" 같은 동어반복이 남는다.
    var ownValues = {};
    (cell.kind === 'axis' ? [cell.value] : cell.values).forEach(function (v) { ownValues[v] = true; });

    var definingCache = {};
    function isDefining(tag) {
      if (definingCache[tag] !== undefined) return definingCache[tag];
      var ax = classify({ title: '', tags: [tag] }, opt.taxonomy).axes;
      var hit = AXIS_KEYS.some(function (a) {
        return (ax[a] || []).some(function (v) { return ownValues[v]; });
      });
      definingCache[tag] = hit;
      return hit;
    }

    /** 태그 등장 비율 */
    function tagRate(list) {
      var counts = {};
      list.forEach(function (w) {
        var seen = {};
        (w.tags || []).forEach(function (t) {
          if (seen[t]) return;
          seen[t] = true;
          counts[t] = (counts[t] || 0) + 1;
        });
      });
      var out = {};
      Object.keys(counts).forEach(function (t) { out[t] = counts[t] / list.length; });
      return out;
    }

    var topRate = tagRate(top), botRate = tagRate(bottom), allRate = tagRate(works);

    // 상위권 - 하위권 등장률 차이. 셀을 정의하는 태그는 양쪽에 다 있으므로 자연히 0에 수렴한다.
    var diffs = [];
    var allTags = {};
    Object.keys(topRate).forEach(function (t) { allTags[t] = true; });
    Object.keys(botRate).forEach(function (t) { allTags[t] = true; });

    // 승패 태그는 셀을 상·하위로 쪼개므로 각 절반이 충분히 커야 한다.
    // 작품 5개 셀이면 절반이 2~3개고, 태그 하나 차이로 ±50%p 가 나온다.
    // 그 숫자를 "상위권이 쓰는 요소" 라고 내놓으면 노이즈를 조언으로 파는 것이다.
    var TAG_MIN_WORKS = Math.max(10, opt.minSupport * 2);
    var tagAnalysisReliable = works.length >= TAG_MIN_WORKS;

    if (tagAnalysisReliable) {
      Object.keys(allTags).forEach(function (t) {
        if (isDefining(t)) return;
        var support = Math.round((allRate[t] || 0) * works.length);
        if (support < 3) return;                     // 2건 이하 태그는 여전히 노이즈
        diffs.push({
          tag: t,
          diff: (topRate[t] || 0) - (botRate[t] || 0),
          topRate: topRate[t] || 0,
          botRate: botRate[t] || 0,
          support: support
        });
      });
      diffs.sort(function (a, b) { return b.diff - a.diff; });
    }

    var companions = Object.keys(allRate)
      .filter(function (t) { return !isDefining(t) && allRate[t] >= 0.3; })
      .sort(function (a, b) { return allRate[b] - allRate[a]; })
      .slice(0, 8)
      .map(function (t) { return { tag: t, rate: +(allRate[t]).toFixed(2) }; });

    var brief = function (w) {
      return {
        title: w.title,
        velocity: +w.velocity.toFixed(1),
        chats: w.chats,
        ageDays: Math.round(w.ageDays),
        tags: (w.tags || []).slice(0, 6)
      };
    };

    return {
      distribution: {
        p25: +q(0.25).toFixed(1),
        median: +q(0.5).toFixed(1),
        p75: +q(0.75).toFixed(1),
        max: +(vels[vels.length - 1] || 0).toFixed(1),
        // 상위 25%와 중앙값의 배율 — 클수록 "터지면 크게 터지는" 변동성 높은 구간
        spread: q(0.5) > 0 ? +(q(0.75) / q(0.5)).toFixed(2) : 0
      },
      topWorks: sorted.slice(0, 3).map(brief),
      medianWork: brief(sorted[Math.floor(sorted.length / 2)]),
      tagAnalysisReliable: tagAnalysisReliable,
      tagAnalysisNote: tagAnalysisReliable ? null
        : '작품 ' + works.length + '건으로는 상·하위 태그 비교가 노이즈입니다 (최소 ' +
          TAG_MIN_WORKS + '건 필요).',
      winningTags: diffs.filter(function (d) { return d.diff >= 0.25; }).slice(0, 5),
      losingTags: diffs.filter(function (d) { return d.diff <= -0.25; }).slice(-5).reverse(),
      companions: companions,
      ageProfile: {
        recent: works.filter(function (w) { return w.isRecent; }).length,
        total: works.length,
        medianAgeDays: Math.round(median(works.map(function (w) { return w.ageDays; })))
      }
    };
  }

  /* ===========================================================================
   * 7-e. 가중치 민감도 (robustness)
   * ========================================================================= */
  /**
   * 신뢰구간은 "표본이 달랐다면?" 을 다룬다.
   * 이건 "가중치를 달리 줬다면?" 을 다룬다. 둘은 다른 불확실성이다.
   *
   * 가중치를 무작위로 흔들어 각 셀이 상위 N에 남는 비율을 센다.
   * 백분위가 이미 계산돼 있으므로 재점수는 내적 한 번이라 매우 싸다.
   *
   * 어떤 가중치를 줘도 상위에 남는 셀이 진짜 추천이고,
   * 특정 가중치에서만 1위인 셀은 그 가중치를 고른 사람의 취향일 뿐이다.
   */
  function computeRobustness(cells, opt, rand) {
    var trials = opt.robustnessTrials;
    if (!trials || cells.length < 2) {
      cells.forEach(function (c) { c.robustness = null; });
      return;
    }

    var KEYS = SCORE_KEYS;
    var topN = Math.min(opt.topN, cells.length);
    var hits = cells.map(function () { return 0; });

    for (var t = 0; t < trials; t++) {
      // 무작위 가중치 (합이 1이 되도록 정규화)
      var w = [], sum = 0;
      for (var i = 0; i < KEYS.length; i++) { var r = rand(); w.push(r); sum += r; }
      if (sum <= 0) continue;

      var scored = cells.map(function (c, idx) {
        var s = 0;
        for (var j = 0; j < KEYS.length; j++) s += (w[j] / sum) * c.p[KEYS[j]];
        return { idx: idx, s: s };
      });
      scored.sort(function (a, b) { return b.s - a.s; });
      for (var k = 0; k < topN; k++) hits[scored[k].idx]++;
    }

    cells.forEach(function (c, i) { c.robustness = +(hits[i] / trials).toFixed(3); });
  }

  /* ===========================================================================
   * 8. 미개척 조합(whitespace) 탐지 — lift 기반
   * ========================================================================= */
  /**
   * lift = 관측 조합 비중 / (축A 비중 × 축B 비중)
   *  · lift << 1  : 아무도 안 만든 조합
   *  · 두 축 각각의 기회점수가 높은데 lift 가 낮으면 = 미개척 후보
   *
   * 조합 자체에 표본이 거의 없으므로 이건 "검증된 추천" 이 아니라 "가설" 이다.
   * 결과에도 confidence: 'hypothesis' 로 표시한다.
   */
  function findWhitespace(works, axisCells, opt) {
    var byAxis = {};
    AXIS_KEYS.forEach(function (ax) {
      byAxis[ax] = {};
      (axisCells[ax] || []).forEach(function (c) { byAxis[ax][c.value] = c; });
    });

    var total = works.length;
    var out = [];

    opt.comboAxes.forEach(function (pair) {
      var axA = pair[0], axB = pair[1];
      var cellsA = axisCells[axA] || [], cellsB = axisCells[axB] || [];

      // 실제 동시 등장 횟수
      var obs = {};
      works.forEach(function (w) {
        (w.axes[axA] || []).forEach(function (a) {
          (w.axes[axB] || []).forEach(function (b) {
            var key = a + '|' + b;
            obs[key] = (obs[key] || 0) + 1;
          });
        });
      });

      cellsA.forEach(function (ca) {
        cellsB.forEach(function (cb) {
          var key = ca.value + '|' + cb.value;
          var observed = obs[key] || 0;

          // 기대 동시 등장 = 독립 가정
          var expected = (ca.stats.count / total) * (cb.stats.count / total) * total;
          if (expected < 0.5) return;                       // 기대값 자체가 미미하면 판단 불가

          var lift = (observed + 0.5) / (expected + 0.5);   // 라플라스 평활
          if (lift >= 0.75) return;                         // 충분히 만들어진 조합은 제외
          if (observed >= opt.minSupport) return;           // 이미 표본이 쌓였으면 combo 쪽에서 다룸

          // 두 축 각각이 매력적이어야 한다
          var strength = (ca.score / 100) * (cb.score / 100);
          if (strength <= 0) return;

          out.push({
            type: 'whitespace',
            confidence: 'hypothesis',
            axes: [axA, axB],
            values: [ca.value, cb.value],
            label: ca.value + ' × ' + cb.value,
            observed: observed,
            expected: Math.round(expected * 10) / 10,
            lift: lift,
            score: 100 * strength * (1 - clamp(lift, 0, 1)),
            parents: [
              { axis: axA, value: ca.value, score: ca.score, gap: ca.gap },
              { axis: axB, value: cb.value, score: cb.score, gap: cb.gap }
            ],
            risks: [{ code: 'UNPROVEN', label: '검증 표본 없음 (' + observed + '개)' }]
          });
        });
      });
    });

    return out.sort(function (a, b) { return b.score - a.score; });
  }

  /* ===========================================================================
   * 9. 로그라인 생성 — 추천 조합을 한 문장으로
   * ========================================================================= */
  /** 마지막 글자에 받침이 있는지 — 한글 음절은 0xAC00 부터 28개 단위로 종성이 순환 */
  function hasJongseong(word) {
    if (!word) return false;
    var code = word.charCodeAt(word.length - 1);
    if (code < 0xAC00 || code > 0xD7A3) return false;   // 한글 음절이 아니면 판단 불가
    return (code - 0xAC00) % 28 !== 0;
  }

  /** 받침에 맞는 조사 선택 (을/를, 은/는, 이/가, 으로/로) */
  function particle(word, withJong, withoutJong) {
    return word + (hasJongseong(word) ? withJong : withoutJong);
  }

  function buildLogline(map) {
    var parts = [];
    if (map.setting)   parts.push(particle(map.setting, '을', '를') + ' 배경으로');
    if (map.archetype) parts.push(map.archetype + ' 성향의 상대와');
    if (map.relation)  parts.push(map.relation + ' 관계로 얽히는');
    if (map.tone)      parts.push(map.tone + ' 분위기의');

    var genre = map.genre || '이야기';
    // 축이 하나뿐이면 문장이 되지 않으므로 최소한의 형태로 보완한다
    if (!parts.length) return genre + ' 소재의 새로운 플롯';
    return parts.join(' ') + ' ' + genre;
  }

  /** 조합 셀 → 축 이름 맵 */
  function comboAxisMap(item) {
    var map = {};
    (item.axes || []).forEach(function (ax, i) { map[ax] = item.values[i]; });
    return map;
  }

  /* ===========================================================================
   * 9-b. 플롯 시드 — 추천을 에디터가 바로 읽는 초안으로
   * ========================================================================= */

  /** 분석기의 캐릭터 축 → 에디터 말투 옵션 id */
  var ARCHETYPE_TO_TONE = {
    '다정': 'kind', '순정': 'kind', '소심': 'kind',
    '츤데레': 'tsun', '도도': 'tsun',
    '허당': 'funny',
    '카리스마': 'chic', '무심': 'chic', '천재': 'chic', '미스터리한': 'chic', '얀데레': 'chic',
    '어른스러운': 'polite',
    '능글': 'playful', '열혈': 'playful', '반항아': 'playful'
  };

  /** 정서 축 → 에디터 스타일 수치 보정 */
  var TONE_TO_STYLE = {
    '몽환': { creativity: 15, length: 'long' },
    '서정': { creativity: 5,  length: 'long' },
    '애절': { creativity: 5,  length: 'long' },
    '잔잔': { creativity: -15, length: 'normal' },
    '코믹': { creativity: 5,  length: 'short', emoji: true },
    '집착': { creativity: 10, length: 'long' },
    '다크': { creativity: 10, length: 'long' },
    '자극': { creativity: 10, length: 'normal' },
    '치유': { creativity: -5, length: 'normal' },
    '달달': { creativity: 0,  length: 'normal', emoji: true }
  };

  /**
   * 추천 조합을 플롯 에디터가 그대로 불러올 수 있는 초안으로 변환한다.
   * 분석 결과가 화면에서 끝나지 않고 실제 작성으로 이어지도록 하는 연결부다.
   *
   * 채우는 것은 뼈대뿐이다 — 이름, 설정 방향, 로어북 항목, 스타일 값.
   * 실제 문장은 사람이 쓴다.
   */
  function buildPlotSeed(cell) {
    var map = comboAxisMap(cell);
    var style = {
      tones: [], emoji: false, narration: true, banmal: false, safeMode: true,
      creativity: 65, memory: 50, length: 'normal', person: 'third', language: 'ko'
    };

    // 캐릭터 축이 조합에 없으면 데이터에서 유추한다.
    // 이 구간 작품 대부분이 '얀데레' 를 달고 있는데 말투를 기본값으로 두면
    // 시드가 실제 시장과 어긋난 채 시작된다.
    var archetype = map.archetype;
    if (!archetype && cell.detail && cell.detail.companions) {
      for (var i = 0; i < cell.detail.companions.length; i++) {
        var c = cell.detail.companions[i];
        if (c.rate < 0.5) break;                     // 과반이 아니면 대표성이 없다
        var ax = classify({ title: '', tags: [c.tag] }).axes;
        if (ax.archetype && ax.archetype.length) { archetype = ax.archetype[0]; break; }
      }
    }

    if (archetype && ARCHETYPE_TO_TONE[archetype]) style.tones.push(ARCHETYPE_TO_TONE[archetype]);
    if (!style.tones.length) style.tones.push('kind');

    var adj = map.tone ? TONE_TO_STYLE[map.tone] : null;
    if (adj) {
      style.creativity = clamp(style.creativity + (adj.creativity || 0), 0, 100);
      if (adj.length) style.length = adj.length;
      if (adj.emoji) style.emoji = true;
    }

    // 로어북 — 축마다 한 항목. 키워드는 사전에서 그대로 가져온다.
    var lore = [];
    AXIS_KEYS.forEach(function (axis) {
      var value = map[axis] || (axis === 'archetype' ? archetype : null);
      if (!value) return;
      var kws = (TAXONOMY[axis].values[value] || []).slice(0, 6);
      lore.push({
        title: TAXONOMY[axis].label + ' · ' + value,
        keywords: kws.join(', '),
        content: LORE_HINT[axis] ? LORE_HINT[axis](value) : (value + ' 설정을 여기에 적으세요.'),
        open: false,
        enabled: true
      });
    });

    var desc = buildSeedDesc(map, cell, archetype);

    return {
      name: '',                                  // 이름은 사람이 정한다
      desc: desc,
      about: buildLogline(map) + ' — 시장 분석 기준 기회점수 ' + Math.round(cell.score) + '점.',
      style: style,
      lore: lore,
      source: {
        label: cell.label,
        score: Math.round(cell.score * 10) / 10,
        // 미개척 조합은 표본이 없어 gap 자체가 없다
        gap: cell.gap != null ? +cell.gap.toFixed(2) : null,
        significant: !!cell.significant,
        confidence: cell.kind === 'whitespace' || cell.lift != null ? 'hypothesis' : 'validated'
      }
    };
  }

  /** 축별 로어북 작성 힌트 */
  var LORE_HINT = {
    genre:    function (v) { return v + ' 장르의 규칙을 적으세요. 이 세계에서 당연하게 통하는 것과 금기.'; },
    relation: function (v) { return v + ' 관계의 시작점. 둘이 어떻게 얽혔고 무엇 때문에 벗어나지 못하는가.'; },
    tone:     function (v) { return v + ' 정서를 유지하기 위해 피해야 할 표현과 즐겨 쓸 표현.'; },
    setting:  function (v) { return v + ' 공간의 감각 — 소리, 냄새, 시간대, 사람들의 밀도.'; },
    archetype:function (v) { return v + ' 성향이 드러나는 구체적 습관과 말버릇. 무너지는 순간은 언제인가.'; }
  };

  /** 시드 설명문 — 분석에서 나온 근거를 작성 지침으로 옮긴다 */
  function buildSeedDesc(map, cell, archetype) {
    var lines = [];
    lines.push('[' + buildLogline(map) + ']');
    lines.push('');

    if (map.genre)    lines.push('· 장르: ' + map.genre + ' — 이 장르의 관습을 하나는 지키고 하나는 비트세요.');
    if (archetype)    lines.push('· 성격: ' + archetype + (map.archetype ? '' : ' (같은 구간 다수가 쓰는 성향)') +
                                 ' — 이 성향이 드러나는 장면을 첫 3턴 안에 배치하세요.');
    if (map.relation) lines.push('· 관계: ' + map.relation + ' — 유저와의 거리를 이 관계로 고정하고 시작하세요.');
    if (map.tone)     lines.push('· 정서: ' + map.tone + ' — 대화가 풀릴 때도 이 온도를 유지하세요.');
    if (map.setting)  lines.push('· 배경: ' + map.setting + ' — 공간이 대화에 개입하도록 쓰세요.');

    var d = cell.detail || null;
    if (d && d.companions && d.companions.length) {
      lines.push('');
      lines.push('· 이 구간에서 흔히 함께 쓰이는 요소: ' +
        d.companions.slice(0, 5).map(function (t) {
          return t.tag + '(' + Math.round(t.rate * 100) + '%)';
        }).join(', '));
    }
    if (d && d.tagAnalysisReliable && d.winningTags && d.winningTags.length) {
      lines.push('· 상위권에만 두드러진 요소: ' +
        d.winningTags.map(function (t) { return t.tag; }).join(', '));
    }
    if (d && d.distribution) {
      lines.push('· 이 구간 중앙값 작품은 하루 약 ' + d.distribution.median +
                 '회 대화됩니다 (상위 25%는 ' + d.distribution.p75 + '회).');
    }

    lines.push('');
    lines.push('아래에 캐릭터의 이름, 나이, 현재 상황, 유저와의 첫 접점을 직접 채우세요.');
    return lines.join('\n');
  }

  /* ===========================================================================
   * 10. 메인 — analyze()
   * ========================================================================= */
  function analyze(rawWorks, options) {
    var opt = Object.assign({}, DEFAULTS, options || {});
    opt.weights = Object.assign({}, DEFAULTS.weights, (options && options.weights) || {});

    if (!Array.isArray(rawWorks) || !rawWorks.length) {
      return { error: '분석할 작품 데이터가 없습니다.', meta: { count: 0 } };
    }

    var rand = makeRandom(opt.seed);

    /* --- 정규화 --- */
    var norm = normalizeWorks(rawWorks, opt);
    var works = norm.works;

    /* --- 전역 기준값 (신인 판정 / 성과 중앙값) --- */
    var ctx = {
      followerMedian: median(works.map(function (w) { return w.followers; })),
      velocityMedian: median(works.map(function (w) { return w.velocity; })),
      cohortCount: opt.cohortCount
    };

    /* --- 코호트별 총 수요 (추세 계산의 분모) --- */
    var cohortTotals = [];
    for (var ci = 0; ci < opt.cohortCount; ci++) cohortTotals.push(0);
    works.forEach(function (w) { cohortTotals[w.cohort] += w.demand; });

    /* --- 제작자 적합도 인덱스 --- */
    var myNorm = (opt.myWorks && opt.myWorks.length)
      ? normalizeWorks(opt.myWorks, opt) : null;
    var fitIndex = myNorm ? buildFitIndex(works, myNorm.works) : null;
    var fitOf = makeFitResolver(fitIndex);

    var recentWorks = works.filter(function (w) { return w.isRecent; });
    var totals = {
      n: 0,
      recentCount: recentWorks.length,
      oldCount: works.length - recentWorks.length,
      demand: works.reduce(function (a, w) { return a + w.demand; }, 0),
      globalQuality: median(works.map(function (w) { return w.quality; })),
      globalRecentVelocity: recentWorks.length
        ? median(recentWorks.map(function (w) { return w.velocity; }))
        : (ctx.velocityMedian || 1e-9),
      globalNewcomerRate: 0
    };

    // 신인 전체 성공률 (셀별 축소의 prior 로 사용)
    var newcomers = works.filter(function (w) { return w.followers <= ctx.followerMedian; });
    totals.globalNewcomerRate = newcomers.length
      ? newcomers.filter(function (w) { return w.velocity >= ctx.velocityMedian; }).length / newcomers.length
      : 0.5;

    /** 그룹 내부 총량 — share 계산의 분모 */
    function groupTotals(cells) {
      return {
        n: cells.reduce(function (a, c) { return a + c.stats.n; }, 0),
        demand: cells.reduce(function (a, c) { return a + c.stats.demandSum; }, 0),
        recentCount: totals.recentCount,
        oldCount: totals.oldCount,
        cohortTotals: cohortTotals,
        fitOf: fitOf,
        globalQuality: totals.globalQuality,
        globalRecentVelocity: totals.globalRecentVelocity,
        globalNewcomerRate: totals.globalNewcomerRate
      };
    }

    /* --- 축별 셀 ---
     * 지표는 축 단위로 계산하고, 백분위 정규화는 5개 축을 한 풀에 모아 한 번에 한다.
     * 그래야 "장르의 오피스" 와 "정서의 집착" 점수가 같은 자로 잰 값이 되고,
     * whitespace 에서 두 축의 점수를 곱하는 계산이 성립한다. */
    var allAxisCells = [];
    AXIS_KEYS.forEach(function (axis) {
      var groups = groupByAxis(works, axis);
      var cells = Object.keys(groups).map(function (val) {
        return {
          kind: 'axis', axis: axis, value: val, label: val,
          stats: buildCellStats(groups[val], ctx)
        };
      });
      allAxisCells = allAxisCells.concat(computeCellMetrics(cells, groupTotals(cells), opt, rand));
    });
    finalizeScores(allAxisCells, opt);

    var axisCells = {};
    AXIS_KEYS.forEach(function (axis) {
      axisCells[axis] = allAxisCells
        .filter(function (c) { return c.axis === axis; })
        .sort(function (a, b) { return b.score - a.score; });
    });

    /* --- 조합 셀 (표본이 있는 검증형 추천) ---
     * 지표는 축 조합별로 계산하되, 정규화는 2축·3축을 한 풀에 모아 한 번에 한다.
     * 따로 정규화하면 2축 1위와 3축 1위가 나란히 100점을 받아 병합이 무의미해진다.
     * gap·momentum 등은 모두 비율이라 조합 차수가 달라도 척도가 유지된다. */
    var comboCells = [];
    opt.comboAxes.forEach(function (pair) {
      var groups = groupByPair(works, pair[0], pair[1]);
      var cells = Object.keys(groups).map(function (key) {
        var g = groups[key];
        return {
          kind: 'combo', axes: pair, values: [g.a, g.b], label: key,
          stats: buildCellStats(g.members, ctx)
        };
      });
      comboCells = comboCells.concat(computeCellMetrics(cells, groupTotals(cells), opt, rand));
    });

    (opt.tripleAxes || []).forEach(function (triple) {
      var groups = groupByTriple(works, triple);
      var cells = Object.keys(groups).map(function (key) {
        var g = groups[key];
        return {
          kind: 'triple', axes: triple, values: g.values, label: key,
          stats: buildCellStats(g.members, ctx)
        };
      });
      comboCells = comboCells.concat(computeCellMetrics(cells, groupTotals(cells), opt, rand));
    });

    // 동어반복 조합 표시 — 두 축 값의 작품 집합이 사실상 같으면 발견이 아니다
    var axisIndex = {};
    allAxisCells.forEach(function (c) { axisIndex[c.axis + '|' + c.value] = c; });
    comboCells.forEach(function (c) {
      // 3축 조합은 모든 축 쌍을 검사해 가장 심한 중복도를 취한다.
      // 세 축 중 두 개만 겹쳐도 그 조합은 실질적으로 2축짜리다.
      var worst = 0;
      for (var i = 0; i < c.axes.length; i++) {
        for (var j = i + 1; j < c.axes.length; j++) {
          var A = axisIndex[c.axes[i] + '|' + c.values[i]];
          var B = axisIndex[c.axes[j] + '|' + c.values[j]];
          if (!A || !B) continue;
          var ov = jaccard(A.stats.ids, B.stats.ids);
          if (ov > worst) worst = ov;
        }
      }
      c.overlap = worst;
      c.tautology = c.overlap >= opt.redundancyThreshold;
    });

    finalizeScores(comboCells, opt);
    computeRobustness(comboCells, opt, rand);
    computeRobustness(allAxisCells, opt, rand);

    /* --- 미개척 조합 --- */
    var whitespace = findWhitespace(works, axisCells, opt);

    /* --- 레드오션 ---
     * 절대 임계치(gap < 0.9 등) 대신 상대 기준을 쓴다. 임계치는 데이터 스케일이
     * 바뀌면 아무것도 못 잡거나 전부 잡는다(실제로 초기 버전은 0건이었다).
     * "공급은 평균 이상인데 기회점수는 하위" 인 셀이 정의상 레드오션이다. */
    var supplyValues = comboCells.map(function (c) { return c.supplyShare; });
    var supplyMedian = median(supplyValues);
    var scoreSorted = comboCells.map(function (c) { return c.score; })
                                .sort(function (a, b) { return a - b; });
    var scoreQ1 = scoreSorted.length
      ? scoreSorted[Math.floor(scoreSorted.length * 0.25)] : 0;

    var saturated = comboCells
      .filter(function (c) {
        return !c.provisional && c.supplyShare >= supplyMedian && c.score <= scoreQ1;
      })
      .sort(function (a, b) { return b.supplyShare - a.supplyShare; })
      .slice(0, opt.topN);

    /* --- 최종 추천 ---
     * 동어반복 조합을 걷어낸 뒤, 점수순이 아니라 다양성을 고려해 선별한다.
     * 상위 8개가 전부 같은 장르의 변주라면 선택지가 8개가 아니라 1개다. */
    var provenPool = comboCells.filter(function (c) {
      // gap < 1 은 공급이 수요를 앞선 구간이다. 다른 지표가 좋아도 "이걸 더 만들라"
      // 고 말할 수 없다. 다양성 선별이 후보가 떨어지면 이런 셀로 목록을 채우기
      // 때문에 풀 단계에서 잘라낸다. (레드오션 섹션에는 그대로 남는다)
      return !c.provisional && !c.tautology && c.gap >= 1;
    });
    var proven = selectDiverse(provenPool, opt.topN, opt.diversity)
      .map(function (c) {
        var map = comboAxisMap(c);
        // 시드 설명문이 해설의 승패 태그·성과 분포를 인용하므로 먼저 계산해 셀에 붙인다
        c.detail = opt.explain ? explainCell(c, opt) : null;
        return {
          type: c.gap >= 1.05 ? 'proven-gap' : 'solid',
          confidence: 'validated',
          kind: c.kind,
          label: c.label,
          score: Math.round(c.score * 10) / 10,
          logline: buildLogline(map),
          significant: c.significant,
          trend: c.trendLabel,
          robustness: c.robustness,
          detail: c.detail,
          plotSeed: buildPlotSeed(c),
          evidence: {
            works: c.stats.count,
            supplyShare: +(c.supplyShare * 100).toFixed(1),
            demandShare: +(c.demandShare * 100).toFixed(1),
            gap: +c.gap.toFixed(2),
            gapCI: [+c.gapLo.toFixed(2), +c.gapHi.toFixed(2)],
            momentum: +c.momentum.toFixed(2),
            trend: +c.trend.toFixed(2),
            supplyRush: +c.supplyRush.toFixed(2),
            fit: +c.fit.toFixed(2),
            hhi: +c.stats.hhi.toFixed(2),
            overlap: +c.overlap.toFixed(2),
            medianAgeDays: Math.round(c.stats.medianAge)
          },
          percentiles: c.p,
          risks: c.risks
        };
      });

    var explore = whitespace.slice(0, Math.max(3, Math.floor(opt.topN / 2)))
      .map(function (c) {
        var map = comboAxisMap(c);
        return {
          type: 'whitespace',
          confidence: 'hypothesis',
          kind: 'whitespace',
          label: c.label,
          score: Math.round(c.score * 10) / 10,
          logline: buildLogline(map),
          // 스키마를 검증형 추천과 맞춘다. 표본이 없어 해설·견고성은 계산할 수 없다.
          significant: false,
          trend: null,
          robustness: null,
          detail: null,
          plotSeed: buildPlotSeed(c),
          evidence: {
            works: c.observed,
            expected: c.expected,
            lift: +c.lift.toFixed(2),
            parentScores: c.parents.map(function (p) { return p.value + ' ' + Math.round(p.score); })
          },
          risks: c.risks
        };
      });

    /* --- 경고 --- */
    var warnings = [];

    /* --- 표본 출처 점검 ---
     * 이 엔진에서 가장 중요한 경고다. 어떤 지표를 정교하게 다듬어도
     * 인기순 목록에서만 긁어온 표본이면 결론은 구조적으로 낙관 편향된다.
     * 반대로 최신순 목록은 성과와 무관하게 노출되므로 편향이 없다. */
    var sourceMix = {};
    works.forEach(function (w) { sourceMix[w.source] = (sourceMix[w.source] || 0) + 1; });

    var popularN = sourceMix.popular || 0;
    var newN     = sourceMix['new'] || 0;
    var knownN   = works.length - (sourceMix.unknown || 0);

    if (knownN > 0) {
      var popularRatio = popularN / knownN;
      if (popularRatio > 0.7 && opt.sampling !== 'ranked') {
        warnings.push('표본의 ' + Math.round(popularRatio * 100) +
          '%가 인기순 목록에서 수집됐는데 sampling 이 census 로 설정돼 있습니다. ' +
          'ranked 로 바꾸지 않으면 실패작이 보이지 않아 gap 이 전반적으로 부풀려집니다.');
      }
      if (newN / knownN > 0.6 && opt.sampling === 'ranked') {
        warnings.push('표본의 대부분이 최신순 목록에서 수집됐습니다. 최신순은 성과와 무관하게 ' +
          '노출되므로 생존편향이 없습니다 — sampling 을 census 로 두는 편이 정확합니다.');
      }
      if (newN === 0 && popularN > 0) {
        warnings.push('최신순 목록에서 수집한 표본이 없습니다. 인기 목록만으로는 "실패한 작품" 이 ' +
          '표본에 들어오지 않아 어떤 보정으로도 완전히 복구할 수 없습니다. ' +
          '최신순 탭에서 성과와 무관하게 100건 정도만 더 모으면 추정 품질이 크게 올라갑니다.');
      }
    }

    var collisions = validateTaxonomy(opt.taxonomy || TAXONOMY);
    if (collisions.length) {
      warnings.push('사전 오류: ' + collisions.slice(0, 5).map(function (c) {
        return '"' + c.keyword + '"(' + c.axes.join('/') + ')';
      }).join(', ') + ' 키워드가 여러 축에 중복되어 있습니다. 동어반복 조합의 원인이 됩니다.');
    }

    var tautologies = comboCells.filter(function (c) { return c.tautology; });
    if (tautologies.length) {
      warnings.push('두 축이 같은 작품군을 가리켜 정보량이 없는 조합 ' + tautologies.length +
        '건을 추천에서 제외했습니다 (예: ' + tautologies[0].label + ', 중복도 ' +
        tautologies[0].overlap.toFixed(2) + '). redundancyThreshold(현재 ' +
        opt.redundancyThreshold + ')로 조절할 수 있습니다.');
    }

    // 통계적 유의성 — 추천 대부분이 "노이즈와 구분되지 않음" 인 경우가 흔하다.
    // 점수만 보면 확신하게 되므로 반드시 함께 알린다.
    if (opt.bootstrapSamples > 0 && proven.length) {
      var sig = proven.filter(function (p) { return p.significant; }).length;
      if (sig < proven.length) {
        warnings.push('검증형 추천 ' + proven.length + '건 중 ' + sig +
          '건만 신뢰구간이 1을 벗어납니다. 나머지는 "수요가 공급을 앞선다" 고 단정할 표본이 ' +
          '부족합니다 — 점수 차이를 실력 차이로 읽지 마세요.');
      }
    }

    if (opt.sampling === 'ranked') {
      warnings.push('인기순 상위만 수집된 데이터입니다. 실패작이 보이지 않아 수요/공급 비율이 과대평가됩니다. gap 을 절반으로 보정했지만 결과는 낙관 편향입니다.');
    }
    if (works.length < 60) {
      warnings.push('표본이 ' + works.length + '개로 적습니다. 조합 단위 추천은 참고용으로만 쓰세요.');
    }
    if (norm.unmappedTags.length > 12) {
      warnings.push('사전에 매핑되지 않은 태그가 ' + norm.unmappedTags.length + '종 있습니다. TAXONOMY 를 보강하면 정확도가 올라갑니다.');
    }
    var uncls = works.filter(function (w) {
      return !AXIS_KEYS.some(function (a) { return (w.axes[a] || []).length; });
    }).length;
    if (uncls > 0) {
      warnings.push('어떤 축에도 분류되지 않은 작품이 ' + uncls + '개 있습니다(전체의 ' +
        Math.round(uncls / works.length * 100) + '%). 이 작품들은 집계에서 제외됩니다.');
    }

    return {
      meta: {
        count: works.length,
        recentCount: recentWorks.length,
        sampling: opt.sampling,
        conservative: opt.conservative,
        diversity: opt.diversity,
        bootstrapSamples: opt.bootstrapSamples,
        myWorksCount: myNorm ? myNorm.works.length : 0,
        sourceMix: sourceMix,
        cohortTotals: cohortTotals.map(function (v) { return +v.toFixed(1); }),
        significantCells: comboCells.filter(function (c) { return c.significant; }).length,
        totalChats: works.reduce(function (a, w) { return a + w.chats; }, 0),
        followerMedian: ctx.followerMedian,
        velocityMedian: +ctx.velocityMedian.toFixed(2),
        generatedAt: new Date(opt.now || Date.now()).toISOString(),
        weights: opt.weights
      },
      recommendations: proven.concat(explore).sort(function (a, b) { return b.score - a.score; }),
      axisCells: axisCells,
      combos: comboCells.slice(0, 40),
      whitespace: whitespace.slice(0, 20),
      saturated: saturated,
      unmappedTags: norm.unmappedTags.slice(0, 30),
      warnings: warnings,
      works: works
    };
  }

  /* ===========================================================================
   * 10-b. 수집 현장용 파서
   *   앱 화면에 보이는 값은 "1.2만", "3일 전" 같은 형태다.
   *   손으로 환산하다 보면 반드시 틀리므로 엔진이 책임진다.
   * ========================================================================= */

  /** "1.2만" → 12000, "12.3K" → 12300, "1,234" → 1234 */
  function parseCount(input) {
    if (typeof input === 'number') return isFinite(input) ? Math.max(0, Math.round(input)) : 0;
    var s = String(input == null ? '' : input).toLowerCase().replace(/[,\s]/g, '');
    if (!s) return 0;

    var m = s.match(/(-?[0-9]*\.?[0-9]+)(억|만|천|k|m|b)?/);
    if (!m) return 0;

    var v = parseFloat(m[1]);
    if (!isFinite(v)) return 0;

    var mult = { '억': 1e8, '만': 1e4, '천': 1e3, k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1;
    return Math.max(0, Math.round(v * mult));
  }

  /** "3일 전" → ISO 날짜. 절대 날짜가 오면 그대로 정규화한다. */
  function parseRelativeDate(input, now) {
    var base = now || Date.now();
    var s = String(input == null ? '' : input).trim();
    if (!s) return null;

    var iso = function (ms) { return new Date(ms).toISOString().slice(0, 10); };

    if (/방금|지금/.test(s)) return iso(base);
    if (/오늘/.test(s))      return iso(base);
    if (/어제/.test(s))      return iso(base - DAY);
    if (/그저께|그제/.test(s)) return iso(base - 2 * DAY);

    // 연도가 보이면 절대 날짜로 해석 (2026-05-01, 2026.05.01, 2026/5/1)
    if (/\d{4}/.test(s)) {
      var abs = Date.parse(s.replace(/[.\/]/g, '-').replace(/-+$/, ''));
      if (isFinite(abs)) return iso(abs);
    }

    var m = s.match(/(\d+)\s*(초|분|시간|일|주|개월|달|년)/);
    if (!m) return null;

    var n = parseInt(m[1], 10);
    var days = { '초': 0, '분': 0, '시간': 0, '일': 1, '주': 7, '개월': 30, '달': 30, '년': 365 }[m[2]];
    return iso(base - n * days * DAY);
  }

  /**
   * 붙여넣은 한 덩어리 텍스트에서 작품 정보를 추출한다.
   * 앱에서 카드를 복사하면 제목·해시태그·숫자·상대날짜가 뒤섞여 들어온다.
   */
  function parsePasted(text, now) {
    var raw = String(text == null ? '' : text).replace(/\r/g, '');
    var lines = raw.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    if (!lines.length) return null;

    var tags = [];
    var out = { title: '', tags: [], chats: 0, likes: 0, createdAt: null };

    // 해시태그 수집 후 본문에서 제거
    var body = lines.map(function (line) {
      return line.replace(/#([^\s#,]+)/g, function (_, t) { tags.push(t); return ' '; });
    });

    // 숫자 후보 — 큰 값을 대화수, 그 다음을 좋아요로 본다
    var nums = [];
    body.forEach(function (line) {
      var re = /([0-9][0-9,.]*\s*(?:억|만|천|k|m|b)?)/gi;
      var m;
      while ((m = re.exec(line))) {
        if (/^\d{4}[-./]/.test(m[1])) continue;          // 날짜는 제외
        var v = parseCount(m[1]);
        if (v > 0) nums.push(v);
      }
    });
    nums.sort(function (a, b) { return b - a; });
    out.chats = nums[0] || 0;
    out.likes = nums[1] || 0;

    // 날짜
    for (var i = 0; i < lines.length; i++) {
      var d = parseRelativeDate(lines[i], now);
      if (d) { out.createdAt = d; break; }
    }

    // 제목 — 숫자/태그가 아닌 첫 줄
    for (var j = 0; j < lines.length; j++) {
      var cand = lines[j].replace(/#([^\s#,]+)/g, '').trim();
      if (cand.length >= 2 && !/^[0-9,.\s만천억kmb%]+$/i.test(cand) &&
          !parseRelativeDate(cand, now)) {
        out.title = cand;
        break;
      }
    }

    // 해시태그가 없으면 쉼표 구분 줄을 태그로 간주
    if (!tags.length) {
      lines.forEach(function (line) {
        if (line.indexOf(',') > 0 && line.length < 80 && line !== out.title) {
          line.split(',').forEach(function (t) {
            var v = t.trim();
            if (v && v.length < 20) tags.push(v);
          });
        }
      });
    }

    var seen = {};
    out.tags = tags.filter(function (t) {
      var k = t.toLowerCase();
      if (seen[k]) return false;
      seen[k] = true; return true;
    });

    return out;
  }

  /* ===========================================================================
   * 11. 입력 파서 — CSV
   *     컬럼: id,title,tags,createdAt,chats,likes,creatorFollowers
   *     tags 는 | 또는 , 로 구분
   * ========================================================================= */
  function parseCSV(text) {
    var rows = [];
    var row = [], field = '', inQuote = false;

    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQuote) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuote = false;
        } else field += ch;
      }
      // 따옴표는 필드 맨 앞에서만 인용을 연다.
      // 중간에 나온 따옴표(예: 5"3)는 리터럴로 취급 — 실제 수집 데이터는
      // RFC4180 을 지키지 않는 경우가 많아 관대하게 파싱한다.
      else if (ch === '"' && field === '') inQuote = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch !== '\r') field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];

    var header = rows.shift().map(function (h) { return h.trim(); });
    return rows.filter(function (r) { return r.some(function (c) { return c.trim(); }); })
      .map(function (r) {
        var o = {};
        header.forEach(function (h, i) { o[h] = (r[i] || '').trim(); });
        return {
          id: o.id,
          title: o.title,
          tags: (o.tags || '').split(/[|,]/).map(function (t) { return t.trim(); }).filter(Boolean),
          createdAt: o.createdAt,
          // 수집 화면의 표기를 그대로 붙여넣어도 되도록 관대하게 파싱한다
          chats: parseCount(o.chats),
          likes: parseCount(o.likes),
          creatorFollowers: parseCount(o.creatorFollowers),
          source: o.source || 'unknown',
          rank: o.rank ? num(o.rank) : null
        };
      });
  }

  /* ===========================================================================
   * public API
   * ========================================================================= */
  return {
    TAXONOMY: TAXONOMY,
    AXIS_KEYS: AXIS_KEYS,
    DEFAULTS: DEFAULTS,
    analyze: analyze,
    classify: classify,
    parseCSV: parseCSV,
    validateTaxonomy: validateTaxonomy,
    selectDiverse: selectDiverse,
    parseCount: parseCount,
    parseRelativeDate: parseRelativeDate,
    parsePasted: parsePasted,
    explainCell: explainCell,
    buildPlotSeed: buildPlotSeed,
    // 테스트/확장을 위해 내부 함수도 노출
    _internal: {
      percentileRank: percentileRank,
      shrink: shrink,
      median: median,
      jaccard: jaccard,
      hasJongseong: hasJongseong,
      buildIndex: buildIndex,
      makeRandom: makeRandom,
      linregSlope: linregSlope,
      bootstrapGapCI: bootstrapGapCI,
      cellSimilarity: cellSimilarity,
      buildFitIndex: buildFitIndex,
      groupByTriple: groupByTriple,
      normalizeWorks: normalizeWorks,
      groupByAxis: groupByAxis,
      groupByPair: groupByPair,
      buildLogline: buildLogline
    }
  };
});
