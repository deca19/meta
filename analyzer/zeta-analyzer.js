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
        '로맨스':     ['로맨스', '연애', '러브', '썸', '사랑', '연상연하', '순애'],
        '판타지':     ['판타지', '마법', '이능', '마왕', '용사', '엘프', '수인'],
        '학원':       ['학원', '고등학생', '대학생', '동아리', '학생'],
        '오피스':     ['오피스', '직장', '직장인', '비서', '사장'],
        '사극·무협':  ['사극', '무협', '조선', '궁중', '왕세자', '검객', '문파'],
        'SF·근미래':  ['sf', '근미래', '사이버펑크', '안드로이드', '로봇'],
        '호러·스릴러':['호러', '공포', '스릴러', '괴담', '살인', '추격'],
        '일상·힐링':  ['일상', '힐링', '슬라이스', '카페'],
        '미스터리':   ['미스터리', '추리', '탐정', '사건', '단서'],
        '아이돌·연예':['아이돌', '연예인', '배우', '매니저', '데뷔', '무대']
      }
    },
    relation: {
      label: '관계',
      values: {
        '짝사랑':     ['짝사랑', '외사랑', '고백'],
        '소꿉친구':   ['소꿉친구', '어릴적친구', '동네친구', '남사친', '여사친'],
        '계약관계':   ['계약', '거래', '위장결혼', '가짜연인', '결혼계약'],
        '상사·부하':  ['상사', '부하', '직속', '사수', '팀장'],
        '사제':       ['선생', '교사', '제자', '스승', '과외'],
        '라이벌':     ['라이벌', '경쟁', '숙적', '대결'],
        '원수·적대':  ['원수', '적대', '복수', '배신', '증오'],
        '재회':       ['재회', '전남친', '전여친', '옛사랑'],
        '동거':       ['동거', '룸메', '한집살이', '하숙'],
        '주종':       ['주인', '집사', '하인', '기사', '주종']
      }
    },
    tone: {
      label: '정서',
      values: {
        '달달':   ['달달', '설렘', '풋풋', '따뜻', '심쿵'],
        '다크':   ['다크', '느와르', '음울', '잔혹', '어두운'],
        '코믹':   ['코믹', '개그', '유머', '웃긴', '병맛'],
        '집착':   ['집착', '광기', '소유욕', '감금'],
        '애절':   ['애절', '슬픔', '눈물', '이별', '비극'],
        '치유':   ['치유', '위로', '포근', '따스함'],
        '자극':   ['자극', '긴장', '스릴', '아슬'],
        '잔잔':   ['잔잔', '담백', '차분', '고요']
      }
    },
    setting: {
      label: '배경',
      values: {
        '현대':       ['현대', '도시', '서울', '현실'],
        '이세계':     ['이세계', '전생', '환생', '차원', '왕국'],
        '아포칼립스': ['아포칼립스', '종말', '좀비', '폐허', '생존'],
        '근미래도시': ['메가시티', '가상현실', '디스토피아'],
        '사극배경':   ['궁', '궁궐', '한양', '무림'],
        '학교':       ['교실', '기숙사', '학교', '캠퍼스'],
        '회사':       ['사무실', '회사', '사내', '오피스텔'],
        '우주':       ['우주', '함선', '행성', '스테이션']
      }
    },
    archetype: {
      label: '캐릭터',
      values: {
        '츤데레':     ['츤데레', '까칠', '퉁명'],
        '얀데레':     ['얀데레', '집착남', '집착녀'],
        '다정':       ['다정', '상냥', '자상', '온화'],
        '카리스마':   ['카리스마', '냉철', '보스', '재벌', '대표'],
        '순정':       ['순정', '순수', '순박', '해맑'],
        '능글':       ['능글', '느끼', '유혹', '플러팅'],
        '무심':       ['무심', '무뚝뚝', '무표정', '건조'],
        '열혈':       ['열혈', '패기', '직진', '저돌'],
        '미스터리한': ['정체불명', '비밀', '수수께끼', '베일']
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
    comboAxes: [            // 교차 분석할 축 쌍
      ['genre', 'relation'],
      ['genre', 'tone'],
      ['setting', 'genre'],
      ['relation', 'archetype'],
      ['tone', 'archetype']
    ],
    weights: {
      gap:       0.30,      // 수요/공급 불균형
      momentum:  0.22,      // 최근작 성과 추세
      openness:  0.16,      // 비독점도 (1 - 집중도)
      newcomer:  0.12,      // 신인 제작자 성공률
      quality:   0.10,      // 좋아요/대화 = 만족도
      staleness: 0.10       // 노후도 = 리프레시 여지
    }
  };

  /* ===========================================================================
   * 3. 수치 유틸
   * ========================================================================= */
  var DAY = 86400000;

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
        demand: velocity,          // 아래에서 윈저화로 덮어씀
        quality: quality
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

    members.forEach(function (m) {
      var w = m.work;
      n += m.weight;
      demandSum += m.weight * w.demand;
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

  /* ===========================================================================
   * 7. 점수화
   * ========================================================================= */
  /**
   * 1단계: 원시 지표 계산.
   *
   * share/gap 은 반드시 자기 그룹(같은 축 또는 같은 축 쌍) 총량 기준으로 계산한다.
   * 장르 축의 공급 비중을 정서 축 총량으로 나누면 의미가 없기 때문이다.
   */
  function computeCellMetrics(cells, totals, opt) {
    if (!cells.length) return [];

    var k = opt.priorStrength;
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
    });

    return cells;
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

    // 백분위 정규화
    var pct = {
      gap:       percentileRank(cells.map(function (c) { return c.gap; })),
      momentum:  percentileRank(cells.map(function (c) { return c.momentum; })),
      openness:  percentileRank(cells.map(function (c) { return c.openness; })),
      newcomer:  percentileRank(cells.map(function (c) { return c.newcomer; })),
      quality:   percentileRank(cells.map(function (c) { return c.quality; })),
      staleness: percentileRank(cells.map(function (c) { return c.staleness; }))
    };

    var w = opt.weights;
    cells.forEach(function (c, i) {
      c.p = {
        gap:       pct.gap[i],
        momentum:  pct.momentum[i],
        openness:  pct.openness[i],
        newcomer:  pct.newcomer[i],
        quality:   pct.quality[i],
        staleness: pct.staleness[i]
      };

      var sum = w.gap * c.p.gap + w.momentum * c.p.momentum + w.openness * c.p.openness
              + w.newcomer * c.p.newcomer + w.quality * c.p.quality + w.staleness * c.p.staleness;
      var wTotal = w.gap + w.momentum + w.openness + w.newcomer + w.quality + w.staleness;

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
   * 10. 메인 — analyze()
   * ========================================================================= */
  function analyze(rawWorks, options) {
    var opt = Object.assign({}, DEFAULTS, options || {});
    opt.weights = Object.assign({}, DEFAULTS.weights, (options && options.weights) || {});

    if (!Array.isArray(rawWorks) || !rawWorks.length) {
      return { error: '분석할 작품 데이터가 없습니다.', meta: { count: 0 } };
    }

    /* --- 정규화 --- */
    var norm = normalizeWorks(rawWorks, opt);
    var works = norm.works;

    /* --- 전역 기준값 (신인 판정 / 성과 중앙값) --- */
    var ctx = {
      followerMedian: median(works.map(function (w) { return w.followers; })),
      velocityMedian: median(works.map(function (w) { return w.velocity; }))
    };

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
      allAxisCells = allAxisCells.concat(computeCellMetrics(cells, groupTotals(cells), opt));
    });
    finalizeScores(allAxisCells, opt);

    var axisCells = {};
    AXIS_KEYS.forEach(function (axis) {
      axisCells[axis] = allAxisCells
        .filter(function (c) { return c.axis === axis; })
        .sort(function (a, b) { return b.score - a.score; });
    });

    /* --- 조합 셀 (표본이 있는 검증형 추천) ---
     * 여기도 동일하게 지표는 축 쌍별, 정규화는 전체 조합 풀에서 한 번에. */
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
      comboCells = comboCells.concat(computeCellMetrics(cells, groupTotals(cells), opt));
    });

    // 동어반복 조합 표시 — 두 축 값의 작품 집합이 사실상 같으면 발견이 아니다
    var axisIndex = {};
    allAxisCells.forEach(function (c) { axisIndex[c.axis + '|' + c.value] = c; });
    comboCells.forEach(function (c) {
      var A = axisIndex[c.axes[0] + '|' + c.values[0]];
      var B = axisIndex[c.axes[1] + '|' + c.values[1]];
      c.overlap = (A && B) ? jaccard(A.stats.ids, B.stats.ids) : 0;
      c.tautology = c.overlap >= opt.redundancyThreshold;
    });

    finalizeScores(comboCells, opt);

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

    /* --- 최종 추천 (동어반복 조합은 제외) --- */
    var proven = comboCells.filter(function (c) { return !c.provisional && !c.tautology; })
      .slice(0, opt.topN)
      .map(function (c) {
        var map = comboAxisMap(c);
        return {
          type: c.gap >= 1.05 ? 'proven-gap' : 'solid',
          confidence: 'validated',
          label: c.label,
          score: Math.round(c.score * 10) / 10,
          logline: buildLogline(map),
          evidence: {
            works: c.stats.count,
            supplyShare: +(c.supplyShare * 100).toFixed(1),
            demandShare: +(c.demandShare * 100).toFixed(1),
            gap: +c.gap.toFixed(2),
            momentum: +c.momentum.toFixed(2),
            supplyRush: +c.supplyRush.toFixed(2),
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
          label: c.label,
          score: Math.round(c.score * 10) / 10,
          logline: buildLogline(map),
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
          chats: num(o.chats),
          likes: num(o.likes),
          creatorFollowers: num(o.creatorFollowers)
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
    // 테스트/확장을 위해 내부 함수도 노출
    _internal: {
      percentileRank: percentileRank,
      shrink: shrink,
      median: median,
      jaccard: jaccard,
      hasJongseong: hasJongseong,
      buildIndex: buildIndex,
      normalizeWorks: normalizeWorks,
      groupByAxis: groupByAxis,
      groupByPair: groupByPair,
      buildLogline: buildLogline
    }
  };
});
