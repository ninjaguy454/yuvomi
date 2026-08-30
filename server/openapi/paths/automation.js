import { op, jsonBody, idParam } from '../helpers.js';

/**
 * Household Automation, assignment obligations and reusable authoring data.
 *
 * Activity Templates and Workflow Templates are deliberately separate from
 * ordinary Tasks: the templates describe how concrete Tasks are generated,
 * while the assignment endpoints below manage the resulting responsibility.
 */
export function automationPaths() {
  return {
    '/api/v1/automation/obligations': {
      get: op({ summary: 'List assignment obligations for the current member', tag: 'Automation' }),
    },
    '/api/v1/automation/admin/obligations': {
      get: op({ summary: 'List assignment obligations for the household', tag: 'Automation', admin: true }),
    },
    '/api/v1/automation/tasks/{id}/claim': {
      post: op({
        summary: 'Claim an open or claimable Task',
        tag: 'Automation',
        params: [idParam()],
        stateChanging: true,
        description: 'Claims the Task for the current member without changing its Activity Template identity or other Task definition fields.',
      }),
    },
    '/api/v1/automation/tasks/{id}/assignment': {
      put: op({
        summary: 'Override a Task assignment',
        tag: 'Automation',
        admin: true,
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Admin assignment override for a generated or manually scheduled Task. The body selects the household member and records the override in the Task assignment context.',
      }),
    },
    '/api/v1/automation/obligations/{id}/respond': {
      post: op({
        summary: 'Accept or decline an assignment obligation',
        tag: 'Automation',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { action: "accept" | "decline", note? }. Only the member who owns the obligation may respond.',
      }),
    },
    '/api/v1/automation/activity-options': {
      get: op({ summary: 'List active Activity Templates for Task authoring', tag: 'Automation' }),
    },
    '/api/v1/automation/quick-add': {
      get: op({ summary: 'List Quick Add Activity and Workflow Templates', tag: 'Automation' }),
    },
    '/api/v1/automation/quick-add/{id}/preview': {
      post: op({
        summary: 'Preview a Workflow Template without creating Tasks',
        tag: 'Automation',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { subject_user_id?, inputs? }. Resolves variables, conditions and assignments without consuming a rotation cursor or writing workflow output.',
      }),
    },
    '/api/v1/automation/quick-add/{id}/create': {
      post: op({
        summary: 'Instantiate a Workflow Template from Quick Add',
        tag: 'Automation',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { subject_user_id?, inputs? }. Creates the Workflow run and its concrete Tasks using the template variables, dependencies and assignment rules.',
      }),
    },
    '/api/v1/automation/member-skills/{userId}': {
      get: op({ summary: 'List effective Skill proficiency for a household member', tag: 'Automation', params: [idParam('userId', 'Household member ID')] }),
    },
    '/api/v1/automation/admin/skills': {
      get: op({ summary: 'List Skills and member proficiency', tag: 'Automation', admin: true }),
      post: op({ summary: 'Create a Skill', tag: 'Automation', admin: true, stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/automation/admin/skills/{id}': {
      put: op({ summary: 'Update a Skill', tag: 'Automation', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete an unused Skill', tag: 'Automation', admin: true, params: [idParam()], stateChanging: true, description: 'Returns 409 while an Activity Template requires the Skill.' }),
    },
    '/api/v1/automation/admin/skills/{skillId}/members/{userId}': {
      put: op({
        summary: 'Set or clear a member Skill-proficiency override',
        tag: 'Automation',
        admin: true,
        params: [idParam('skillId', 'Skill ID'), idParam('userId', 'Household member ID')],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { proficiency }. Null, an empty value, or "auto" restores age-derived proficiency.',
      }),
    },
    '/api/v1/automation/admin/variables': {
      get: op({ summary: 'List reusable household variables and system context variables', tag: 'Automation', admin: true }),
      post: op({ summary: 'Create a reusable household variable', tag: 'Automation', admin: true, stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/automation/admin/variables/{id}': {
      put: op({ summary: 'Update a reusable household variable', tag: 'Automation', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Updates the label, description, type, options and active state while retaining immutable database identity.' }),
      delete: op({ summary: 'Delete an unused reusable household variable', tag: 'Automation', admin: true, params: [idParam()], stateChanging: true, description: 'Returns 409 while a Workflow Template references the variable.' }),
    },
    '/api/v1/automation/admin/variables/{id}/key': {
      put: op({
        summary: 'Rename a reusable variable key and update its references',
        tag: 'Automation',
        admin: true,
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { variable_key }. Rewrites matching Workflow Template tokens and definitions atomically; the variable row ID does not change.',
      }),
    },
    '/api/v1/automation/admin/workflow-templates/{workflowId}/variables/{definitionId}/promote': {
      post: op({
        summary: 'Promote a Workflow variable to a reusable household variable',
        tag: 'Automation',
        admin: true,
        params: [idParam('workflowId', 'Workflow Template ID'), idParam('definitionId', 'Workflow variable definition ID')],
        stateChanging: true,
        description: 'Creates or reuses the matching household variable and updates the local Workflow definition to reference it.',
      }),
    },
    '/api/v1/automation/admin/activity-templates': {
      get: op({ summary: 'List Activity Templates', tag: 'Automation', admin: true }),
      post: op({ summary: 'Create an Activity Template', tag: 'Automation', admin: true, stateChanging: true, requestBody: jsonBody(null), description: 'Defines Task title/description templates, required Skills, assignment and supervision policy, location/presence rules, and first-class Task subtasks.' }),
    },
    '/api/v1/automation/admin/activity-templates/{id}': {
      put: op({ summary: 'Update an Activity Template', tag: 'Automation', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete an unused Activity Template', tag: 'Automation', admin: true, params: [idParam()], stateChanging: true, description: 'Returns 409 while a Workflow Template uses the Activity Template.' }),
    },
    '/api/v1/automation/admin/workflow-templates': {
      get: op({ summary: 'List Workflow Templates and their steps', tag: 'Automation', admin: true }),
      post: op({ summary: 'Create a Workflow Template', tag: 'Automation', admin: true, stateChanging: true, requestBody: jsonBody(null), description: 'Defines variables, ordered Activity Template steps, dependencies, conditions, subject rules and Quick Add visibility.' }),
    },
    '/api/v1/automation/admin/workflow-templates/{id}': {
      put: op({ summary: 'Update a Workflow Template', tag: 'Automation', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a Workflow Template', tag: 'Automation', admin: true, params: [idParam()], stateChanging: true, description: 'Deletes the reusable definition without deleting Tasks already generated from previous runs.' }),
    },
  };
}
