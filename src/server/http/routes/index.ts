// Every HTTP route the office answers, in the order they're tried: a new route goes where it has to
// come in that order (see http/router.ts). The public ones are tried first, then the sign-in check,
// then the rest; the last one answers every path left with the client bundle, or a 404.
import type { Route } from '../router.js';
import { agentRoutes } from './agents.js';
import { authRoutes } from './auth.js';
import { fileRoutes } from './files.js';
import { flowRoutes } from './flows.js';
import { githubRoutes } from './github.js';
import { hiringRoutes } from './hiring.js';
import { membersRoutes } from './members.js';
import { commsRoutes } from './comms.js';
import { ledgerRoutes } from './ledgers.js';
import { pageRoutes } from './pages.js';
import { searchRoutes } from './search.js';
import { teamRoutes } from './team.js';
import { teamMeetingRoutes } from './team-meeting.js';
import { securityRoutes } from './security.js';
import { serviceRoutes } from './services.js';
import { workerBrowserRoutes } from './worker-browser.js';
import { workerChatRoutes } from './worker-chat.js';

export const routes: readonly Route[] = [
  // Anyone.
  authRoutes.login,
  authRoutes.loginOptions,
  authRoutes.join,
  authRoutes.claimable,
  authRoutes.claim,
  authRoutes.link,
  authRoutes.logout,
  pageRoutes.health,
  pageRoutes.assets,
  pageRoutes.login,
  pageRoutes.claim,
  pageRoutes.join,
  pageRoutes.favicon,
  // Signed in.
  authRoutes.whoami,
  agentRoutes.models,
  workerBrowserRoutes.view,
  workerBrowserRoutes.screenshot,
  workerBrowserRoutes.stream,
  workerBrowserRoutes.input,
  workerBrowserRoutes.action,
  workerChatRoutes.transcript,
  teamRoutes.team,
  teamRoutes.action,
  teamRoutes.schedule,
  membersRoutes.list,
  commsRoutes.state,
  ledgerRoutes.state,
  ledgerRoutes.action,
  commsRoutes.action,
  membersRoutes.profile,
  membersRoutes.action,
  hiringRoutes.state,
  hiringRoutes.action,
  flowRoutes.state,
  flowRoutes.action,
  securityRoutes.state,
  securityRoutes.action,
  teamMeetingRoutes.meeting,
  teamMeetingRoutes.minutes,
  teamMeetingRoutes.action,
  fileRoutes.image,
  fileRoutes.whiteboardFile,
  fileRoutes.termDrop,
  fileRoutes.changedFile,
  fileRoutes.docs,
  searchRoutes.search,
  serviceRoutes.forwards,
  githubRoutes.github,
  pageRoutes.office,
  pageRoutes.lite,
  pageRoutes.bundle,
];
