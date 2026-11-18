/* McKithan PWA service worker — cache-first (stale-while-revalidate)
 *
 * 과거 전략은 "network-first" 였다: 설치형 PWA가 실행될 때마다 1.37MB의 index.html과
 * CDN 라이브러리(XLSX·supabase-js·폰트)를 "네트워크에서 먼저" 받은 뒤에야 화면을 그렸다.
 * 이 기기는 기업 SSL 검사 프록시 환경이라 CDN 핸드셰이크가 느리고, 네트워크가 '실패'가
 * 아니라 '지연(hang)' 되면 캐시 폴백도 못 한 채 멈춰서 '먹통'으로 느껴졌다.
 *
 * 이 버전은 정적 자산(앱 셸 + 허용된 CDN 라이브러리/폰트)을 캐시에서 '즉시' 돌려주고,
 * 백그라운드에서 네트워크로 조용히 갱신한다(stale-while-revalidate). 따라서 두 번째
 * 실행부터는 네트워크를 기다리지 않고 바로 뜨며, 배포한 새 버전은 다음 실행 때 반영된다.
 *
 * Supabase(REST/Realtime) 같은 라이브 데이터는 절대 캐시하지 않고 항상 네트워크로 보낸다
 * → 데이터 신선도는 그대로 유지된다.
 */
'use strict';

const CACHE = 'mckithan-v2';

// 런타임에 cache-first 로 담아둘 교차출처 '정적' 호스트(버전 고정 라이브러리 / 폰트).
// 이 목록에 없는 교차출처(특히 *.supabase.co)는 캐시하지 않고 네트워크로 통과시킨다.
const CACHEABLE_HOSTS = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

self.addEventListener('install', () => {
  // 새 SW를 곧바로 활성화 대기 없이 올린다.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 과거 버전 캐시(mckithan-v1 등) 정리 → 새 버전이 깨끗하게 다시 채운다.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isCacheable(url) {
  // 같은 출처(앱 셸: index.html, 아이콘, manifest 등)는 전부 캐시 대상.
  if (url.origin === self.location.origin) return true;
  // 교차출처는 허용 목록(정적 라이브러리/폰트)만.
  return CACHEABLE_HOSTS.includes(url.hostname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;            // 변이 요청(POST 등)은 통과

  const url = new URL(req.url);
  if (!isCacheable(url)) return;               // Supabase 등 라이브 데이터는 네트워크로

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);

    // 백그라운드 갱신: 성공 응답(또는 폰트 등 opaque)만 캐시에 덮어쓴다.
    const update = fetch(req).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    }).catch(() => null);

    if (cached) {
      event.waitUntil(update);                 // 즉시 캐시 반환 + 뒤에서 최신화
      return cached;
    }
    // 캐시에 없으면(최초 1회) 네트워크를 기다렸다가 받고, 그 사이 캐시에도 채운다.
    const net = await update;
    return net || Response.error();
  })());
});
