import { lazy } from 'solid-js';

/**
 * Tools, admin and content pages: the test.pokoin.com review boards, the
 * Scan Connect desk and photo scan, CardTrader sync review, admin, forum,
 * about and careers. Same URLs as the React app; every page is its own
 * chunk. Boards render bare (lib/bare-pages.js).
 */
const TestsDashboard = lazy(() => import('../pages/TestsDashboard.jsx'));
const Sanitize = lazy(() => import('../pages/Sanitize.jsx'));
const Espurr = lazy(() => import('../pages/Espurr.jsx'));
const Ocr = lazy(() => import('../pages/Ocr.jsx'));
const OcrArtists = lazy(() => import('../pages/OcrArtists.jsx'));
const ArtworkHover = lazy(() => import('../pages/ArtworkHover.jsx'));
const JumbosBoard = lazy(() => import('../pages/JumbosBoard.jsx'));
const PokoVideoBoard = lazy(() => import('../pages/PokoVideoBoard.jsx'));
const PokoArchive = lazy(() => import('../pages/PokoArchive.jsx'));
const Admin = lazy(() => import('../pages/Admin.jsx'));
const Scan = lazy(() => import('../pages/Scan.jsx'));
const Forum = lazy(() => import('../pages/Forum.jsx'));
const SyncReview = lazy(() => import('../pages/SyncReview.jsx'));
const ScanDesk = lazy(() => import('../pages/ScanDesk.jsx'));
const About = lazy(() => import('../pages/About.jsx'));
const Careers = lazy(() => import('../pages/Careers.jsx'));

export default [
  { path: '/tests', component: TestsDashboard },
  { path: '/sanitize', component: Sanitize },
  { path: '/espurr', component: Espurr },
  { path: '/ocr', component: Ocr },
  { path: '/ocr/artists', component: OcrArtists },
  { path: '/artwork', component: ArtworkHover },
  { path: '/jumbos', component: JumbosBoard },
  { path: '/poko', component: PokoVideoBoard },
  { path: '/poko/archive', component: PokoArchive },
  { path: '/admin', component: Admin },
  { path: '/marketplace/admin', component: Admin },
  { path: '/marketplace/admin/edit', component: Admin },
  { path: '/scan', component: Scan },
  { path: '/cardscan', component: Scan },
  { path: '/scancard', component: Scan },
  { path: '/dashboard/scan', component: ScanDesk },
  { path: '/inventory/scan', component: ScanDesk },
  { path: '/inventory/sync-review', component: SyncReview },
  { path: '/forum', component: Forum },
  { path: '/forum/category/:categoryId', component: Forum },
  { path: '/forum/topic/:topicId', component: Forum },
  { path: '/about', component: About },
  { path: '/careers', component: Careers },
];
