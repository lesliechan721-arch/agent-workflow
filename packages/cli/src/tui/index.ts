export { createInkPrompt, type InkPromptOptions } from './prompt.js';
export {
  Card,
  HelpBar,
  ScreenFrame,
  Section,
  StatusLabel,
  type TuiSize,
} from './components.js';
export { resolveTuiKeyAction, type TuiInputMode, type TuiKeyContext } from './keys.js';
export { resolveTuiSizePolicy, type TuiLayoutMode, type TuiSizePolicy } from './layout.js';
export { createInkTuiRunner, type TuiLaunchRequest, type TuiRunner } from './runner.js';
export {
  TuiController,
  TuiOperationBlockedError,
  operationEvidenceFingerprint,
  type OperationEvidence,
  type OperationExecuteResult,
  type OperationIntent,
  type OperationResultSummary,
  type OperationReviewModel,
  type TuiControllerDependencies,
  type TuiControllerSnapshot,
} from './controller.js';
export {
  createConsoleTuiV4Controller,
  createTuiControllerDependencies,
} from './controller-runtime.js';
export {
  CONSOLE_V4_SCREEN_IDS,
  ConsoleAppV4,
  resolveConsoleV4ScreenId,
  type ConsoleV4ScreenId,
} from './console-app-v4.js';
export {
  buildConfigGroups,
  buildTuiViewModel,
  projectPlatformPlacement,
  type ConfigFieldViewModel,
  type ConfigGroupViewModel,
  type HomeSummaryViewModel,
  type PlatformPlacementSummary,
  type PluginListItemViewModel,
  type SourceHealthViewModel,
  type SourceTabViewModel,
  type TuiViewModel,
  type UserIssueViewModel,
} from './model.js';
export {
  TuiRouter,
  type TuiPageContext,
  type TuiRoute,
  type TuiRouteFrame,
  type TuiRouterSnapshot,
} from './router.js';
export { CommandWizard } from './wizard.js';
export {
  Dashboard,
  createInitialDashboardState,
  dashboardReducer,
  type DashboardResult,
  type DashboardState,
  type DashboardStateAction,
} from './dashboard.js';
export { getTuiStatusColor, tuiTheme, type TuiStatus } from './theme.js';
export {
  ConfirmView,
  MultiSelectView,
  PasswordInputView,
  PromptFrame,
  SelectView,
  TextInputView,
} from './views.js';
