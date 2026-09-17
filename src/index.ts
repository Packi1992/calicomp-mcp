import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as getHistoryTool        from './tools/get_history.js';
import * as getStatsTool          from './tools/get_stats.js';
import * as getProfileTool        from './tools/get_profile.js';
import * as listTemplatesTool     from './tools/list_templates.js';
import * as getTemplateTool       from './tools/get_template.js';
import * as getExerciseCatalogTool from './tools/get_exercise_catalog.js';
import * as getPlannedWorkoutsTool from './tools/get_planned_workouts.js';
import * as getTrainingStateTool  from './tools/get_training_state.js';
import * as proposePlanUpdateTool  from './tools/propose_plan_update.js';
import * as proposeNewPlanTool     from './tools/propose_new_plan.js';
import * as proposeNewExerciseTool from './tools/propose_new_exercise.js';
import * as proposePlannedUpdateTool from './tools/propose_planned_update.js';
import * as getSuggestionsTool     from './tools/get_suggestions.js';
import * as getSuggestionTool      from './tools/get_suggestion.js';
import * as withdrawSuggestionTool from './tools/withdraw_suggestion.js';
import * as getCoachParametersTool from './tools/get_coach_parameters.js';
import * as setCoachParametersTool from './tools/set_coach_parameters.js';
import * as getAdherenceTool from './tools/get_adherence.js';
import * as getProgressTool from './tools/get_progress.js';
import { pruneExports } from './file-channel.js';

const pat      = process.env.CALICOMP_PAT;
const keyB64   = process.env.CALICOMP_KEY;
const serverUrl = process.env.CALICOMP_SERVER_URL ?? 'https://api.calicompanion.de';

if (!pat || !keyB64) {
  console.error('[calicomp-mcp] FATAL: CALICOMP_PAT and CALICOMP_KEY must be set.');
  process.exit(1);
}

const server = new McpServer({ name: 'calicomp', version: '0.1.0' });
const config = { pat, keyB64, serverUrl };

getHistoryTool.registerToolGetHistory(server, config);
getStatsTool.registerToolGetStats(server, config);
getProfileTool.registerToolGetProfile(server, config);
listTemplatesTool.registerToolListTemplates(server, config);
getTemplateTool.registerToolGetTemplate(server, config);
getExerciseCatalogTool.registerToolGetExerciseCatalog(server, config);
getPlannedWorkoutsTool.registerToolGetPlannedWorkouts(server, config);
getTrainingStateTool.registerToolGetTrainingState(server, config);
proposePlanUpdateTool.registerToolProposePlanUpdate(server, config);
proposeNewPlanTool.registerToolProposeNewPlan(server, config);
proposeNewExerciseTool.registerToolProposeNewExercise(server, config);
proposePlannedUpdateTool.registerToolProposePlannedUpdate(server, config);
getSuggestionsTool.registerToolGetSuggestions(server, config);
getSuggestionTool.registerToolGetSuggestion(server, config);
withdrawSuggestionTool.registerToolWithdrawSuggestion(server, config);
getCoachParametersTool.registerToolGetCoachParameters(server, config);
setCoachParametersTool.registerToolSetCoachParameters(server, config);
getAdherenceTool.registerToolGetAdherence(server, config);
getProgressTool.registerToolGetProgress(server, config);

// Protocol v1.15 §1.5 rule 4: clean up stale export files at every process start.
await pruneExports();

const transport = new StdioServerTransport();
await server.connect(transport);
