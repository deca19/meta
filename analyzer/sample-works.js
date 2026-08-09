/* =============================================================================
 * 합성 샘플 데이터 생성기
 * -----------------------------------------------------------------------------
 * ⚠️ 여기서 나오는 숫자는 ZETA 의 실제 데이터가 아니다.
 *    엔진을 즉시 실행해 보기 위한 가짜 시장이다.
 *    실제 분석에는 직접 수집한 CSV/JSON 을 넣어야 한다.
 *
 * 생성 방식
 *  · 시드 고정 LCG 난수 → 매번 같은 데이터가 나온다(테스트 재현성)
 *  · 레시피(장르+관계+정서+배경+캐릭터)마다 공급 비중과 기저 인기를 다르게 준다
 *  · 인기는 로그정규 분포로 흩뿌린다(실제 UGC 플랫폼의 롱테일 모사)
 *  · 정답을 하드코딩하지 않는다. 공급/수요 비중만 조작하고, 어떤 주제가
 *    상위로 올라오는지는 엔진이 계산한 결과다.
 * ============================================================================= */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ZetaSample = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /** 시드 고정 선형합동 난수 */
  function makeRandom(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /**
   * 레시피 정의
   *  supply : 전체 작품 중 이 레시피가 차지할 상대 비중
   *  appeal : 기저 인기(일평균 대화수의 중앙값 스케일)
   *  trend  : 최근 90일 작품에 곱해지는 성장 계수 (>1 상승세)
   * 공급이 많은데 appeal 이 낮으면 레드오션, 공급이 적은데 appeal 이 높으면 기회다.
   */
  var RECIPES = [
    // 공급 과잉 · 평범한 성과 (전형적 레드오션)
    { supply: 22, appeal: 34, trend: 0.85,
      tags: ['학원', '고등학생', '짝사랑', '달달', '설렘', '교실', '순정'] },
    { supply: 16, appeal: 30, trend: 0.9,
      tags: ['로맨스', '현대', '재벌', '카리스마', '계약', '달달'] },

    // 공급 적당 · 성과 양호
    { supply: 11, appeal: 52, trend: 1.05,
      tags: ['판타지', '이세계', '전생', '기사', '주종', '다정'] },
    { supply: 9, appeal: 46, trend: 1.0,
      tags: ['오피스', '회사', '상사', '사내', '무심', '잔잔'] },

    // 공급 희소 · 성과 매우 좋음 (엔진이 찾아내야 할 구간)
    { supply: 5, appeal: 96, trend: 1.35,
      tags: ['오피스', '상사', '집착', '얀데레', '다크', '사무실'] },
    { supply: 4, appeal: 88, trend: 1.4,
      tags: ['아포칼립스', '생존', '폐허', '동거', '치유', '무뚝뚝'] },

    // 신규 상승세
    { supply: 6, appeal: 62, trend: 1.5,
      tags: ['근미래', '안드로이드', '사이버펑크', '무심', '애절', 'sf'] },
    { supply: 5, appeal: 44, trend: 1.2,
      tags: ['미스터리', '탐정', '사건', '라이벌', '자극', '현대'] },

    // 하락세 / 노후
    { supply: 8, appeal: 26, trend: 0.6,
      tags: ['사극', '조선', '궁', '왕세자', '애절', '순정'] },
    { supply: 4, appeal: 22, trend: 0.7,
      tags: ['호러', '괴담', '공포', '다크', '추격'] },

    // 소수 장르 (표본 부족 셀 → 축소 보정이 동작하는지 확인용)
    { supply: 3, appeal: 78, trend: 1.1,
      tags: ['아이돌', '연예인', '매니저', '소꿉친구', '코믹', '능글'] },
    { supply: 3, appeal: 40, trend: 0.95,
      tags: ['무협', '문파', '검객', '원수', '복수', '다크'] },
    { supply: 4, appeal: 55, trend: 1.15,
      tags: ['일상', '힐링', '카페', '동네친구', '치유', '다정'] },

    // 태그 사전에 없는 것들이 섞인 케이스 (미분류 태그 집계 확인용)
    { supply: 3, appeal: 38, trend: 1.0,
      tags: ['수인', '테이머', '길들이기', '판타지', '츤데레'] }
  ];

  var TITLE_HEAD = ['비 오는 날의', '어제의', '마지막', '조용한', '새벽 세시', '잊혀진',
                    '두 번째', '붉은', '겨울의', '너와 나의', '끝나지 않는', '작은'];
  var TITLE_TAIL = ['약속', '거리', '온도', '이름', '문장', '기록', '방', '계절',
                    '골목', '목소리', '밤', '자리'];

  /**
   * 작품 목록 생성
   * @param {number} count 생성할 작품 수
   * @param {number} seed  난수 시드
   * @param {number} nowMs 기준 시각(고정하면 결과가 완전히 재현된다)
   */
  function generate(count, seed, nowMs) {
    var rand = makeRandom(seed === undefined ? 20260809 : seed);
    var now = nowMs || Date.parse('2026-08-09T00:00:00Z');
    var DAY = 86400000;

    // supply 비중을 누적 분포로 변환
    var totalSupply = RECIPES.reduce(function (a, r) { return a + r.supply; }, 0);
    var cum = [], acc = 0;
    RECIPES.forEach(function (r) { acc += r.supply / totalSupply; cum.push(acc); });

    function pickRecipe() {
      var x = rand();
      for (var i = 0; i < cum.length; i++) if (x <= cum[i]) return RECIPES[i];
      return RECIPES[RECIPES.length - 1];
    }

    /** Box-Muller 표준정규 */
    function gauss() {
      var u = Math.max(rand(), 1e-9), v = Math.max(rand(), 1e-9);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    var works = [];
    for (var i = 0; i < (count || 180); i++) {
      var r = pickRecipe();

      // 작품 나이: 0~540일, 최근일수록 조금 더 많이 생성(플랫폼 성장 모사)
      var ageDays = Math.floor(Math.pow(rand(), 1.35) * 540) + 1;
      var isRecent = ageDays <= 90;

      // 일평균 대화수 = 기저 인기 × 로그정규 노이즈 × (최근작이면 트렌드 계수)
      var noise = Math.exp(gauss() * 0.95);
      var velocity = r.appeal * noise * (isRecent ? r.trend : 1) / 10;
      velocity = Math.max(0.05, velocity);

      var chats = Math.round(velocity * ageDays);
      // 좋아요 비율은 레시피 인기와 약하게 연동 + 노이즈
      var likeRate = Math.min(0.35, Math.max(0.01, (r.appeal / 400) * Math.exp(gauss() * 0.4)));
      var likes = Math.round(chats * likeRate);

      // 제작자 팔로워: 롱테일. 인기작일수록 팔로워 많을 확률이 높지만 상관은 약하게.
      var followers = Math.round(Math.exp(gauss() * 1.3 + 4) * (1 + velocity / 40));

      // 태그: 레시피 태그 중 4~7개를 뽑아 순서 섞기
      var pool = r.tags.slice();
      var take = 4 + Math.floor(rand() * Math.min(4, pool.length - 3));
      var tags = [];
      for (var t = 0; t < take && pool.length; t++) {
        tags.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
      }

      works.push({
        id: 'zw' + String(i + 1).padStart(4, '0'),
        title: TITLE_HEAD[Math.floor(rand() * TITLE_HEAD.length)] + ' ' +
               TITLE_TAIL[Math.floor(rand() * TITLE_TAIL.length)],
        tags: tags,
        createdAt: new Date(now - ageDays * DAY).toISOString().slice(0, 10),
        chats: chats,
        likes: likes,
        creatorFollowers: followers
      });
    }
    return works;
  }

  return { generate: generate, RECIPES: RECIPES, makeRandom: makeRandom };
});
