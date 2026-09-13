import { buildPaths } from './openapi/paths/index.js';
import { idempotencyHeaderParam } from './openapi/helpers.js';
import { apiTags } from './openapi/tags.js';
import { schemas } from './openapi/schemas.js';

/**
 * Traegt den `Idempotency-Key`-Header an jeder POST-Operation nach, die von der
 * Middleware ueberhaupt erreicht wird (#822).
 *
 * `/api/v1/auth/*` bleibt aussen vor, und das ist keine Feinheit: der
 * Auth-Router haengt in `index.js` VOR `requireAuth`, also vor der Middleware.
 * Ein dort dokumentierter Header waere eine Zusage, die niemand einloest.
 *
 * @param {Record<string, any>} paths
 * @returns {Record<string, any>} dieselben Pfade, POSTs angereichert
 */
function withIdempotency(paths) {
  for (const [path, item] of Object.entries(paths)) {
    if (!item?.post) continue;
    if (!path.startsWith('/api/v1/') || path.startsWith('/api/v1/auth/')) continue;
    item.post.parameters = [...(item.post.parameters ?? []), idempotencyHeaderParam()];
    item.post.responses = {
      ...item.post.responses,
      409: {
        description: 'Idempotency-Key conflict: reused for a different request, or the first attempt is still running',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        ...(item.post.responses?.[409] ?? {}),
      },
    };
  }
  return paths;
}

// Document the existing optimistic-write boundary for API and MCP clients.
// This annotates the published contract; enforcement remains in the routers.
function withTaskRevisions(paths) {
  const field=description=>({type:'integer',minimum:1,description});
  const taskFields={
    expected_revision:field('The revision from the Task snapshot being changed. Read the Task before editing; never fetch and silently substitute a newer revision for an old edit.'),
    expected_parent_revision:field('Required when the Task has a parent. Use parent_revision from that same Task snapshot.'),
  };
  const annotate=(operation,{required=true,supervisor=false,description}={})=>{
    const previous=operation.requestBody?.content?.['application/json']?.schema||{type:'object',additionalProperties:true};
    operation.requestBody={required:true,description:'Task snapshot and requested changes',content:{'application/json':{schema:{...previous,
      properties:{...previous.properties,...(supervisor?{expected_revision:taskFields.expected_revision,expected_source_revision:field('Required when addressing a child or helper projection instead of the canonical source Task. Use supervision.source_revision from the rendered snapshot.')}:taskFields)},
      required:[...new Set([...(previous.required||[]),...(required?['expected_revision']:[])])],
    }}}};
    operation.description=[operation.description,description||'Requires expected_revision. A subtask also requires expected_parent_revision. Missing tokens return 428; stale tokens return 409 without applying the edit. Refresh the Task and review the change before retrying.'].filter(Boolean).join('\n\n');
    operation.responses[428]={description:'Task revision required: refresh/update the client before changing existing Task state.',content:{'application/json':{schema:{$ref:'#/components/schemas/ApiError'}}}};
    operation.responses[409]={description:'Stale Task snapshot, required lifecycle confirmation, or conflicting request. No stale mutation is applied.',content:{'application/json':{schema:{$ref:'#/components/schemas/ApiError'}}}};
  };
  for(const [path,item] of Object.entries(paths)){
    if(path.startsWith('/api/v1/tasks/{id}'))for(const [method,operation] of Object.entries(item)){
      if(!['post','put','patch','delete'].includes(method))continue;
      if(path==='/api/v1/tasks/{id}/comments'&&method==='post'){
        operation.description+=' Appending a new comment does not replace existing work and does not require Task revision tokens.';
        continue;
      }
      const supervisor=path.endsWith('/supervisor');
      annotate(operation,{supervisor,...(supervisor?{description:'Choose one supervisor for the entire remaining supervised scope. expected_revision is required for the addressed Task; addressing a child/helper also requires expected_source_revision for the canonical source Task. Use supervision.source_task_id and supervision.source_revision to address that source directly. Missing tokens return 428; stale tokens return 409 without changing supervision.'}:{})});
    }
    if(/^\/api\/v1\/automation\/tasks\/\{id\}\/(claim|assignment)$/.test(path))for(const method of ['post','put'])if(item[method])annotate(item[method]);
    if(path==='/api/v1/automation/obligations/{id}/respond')annotate(item.post,{required:false,description:'When the obligation is linked to a Task, expected_revision is required and expected_parent_revision is required if that Task has a parent. Use task_revision and task_parent_revision from the obligation read. Obligations without a Task do not require Task tokens.'});
    if(/^\/api\/v1\/housekeeping\/visits\/\{id\}(\/pay)?$/.test(path))for(const method of ['post','put','delete'])if(item[method])annotate(item[method],{required:false,description:'When the visit has a linked payment Task, include expected_revision from payment_task_revision and, when present, expected_parent_revision from payment_task_parent_revision returned by the visit read. Visits without a payment Task do not require Task tokens.'});
  }
  const create=paths['/api/v1/tasks'].post;
  create.description+=' Creating a top-level Task needs no revision token. Adding a subtask requires expected_parent_revision from the parent snapshot; missing tokens return 428 and stale tokens return 409.';
  create.requestBody.content['application/json'].schema.properties={expected_parent_revision:field('Required when adding a subtask. Use revision from the parent Task snapshot.')};
  for(const suffix of ['/documents','/comments'])paths[`/api/v1/tasks/{id}${suffix}`].get.description+=' The response also includes task_revision and task_parent_revision for subsequent replacement/edit/delete operations.';
  paths['/api/v1/tasks/{id}'].get.description+=' Includes revision, and parent_revision for subtasks, for optimistic writes.';
  return paths;
}

function buildOpenApiSpec(req, appVersion) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Vidamia API',
      version: appVersion,
      description: 'OpenAPI documentation for the Vidamia family organizer backend.',
    },
    servers: [{ url: '/', description: 'Current origin' }],
    tags: apiTags,
    paths: withIdempotency(withTaskRevisions(buildPaths())),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'API token sent in the Authorization header as `Bearer <token>`.',
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'API token sent in the `X-API-Key` header. `API-Key` is also accepted for MCP compatibility.',
        },
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'yuvomi.sid',
          description: 'Browser session cookie. State-changing requests also require `X-CSRF-Token`.',
        },
      },
      responses: {
        BadRequest: {
          description: 'Bad request',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        Unauthorized: {
          description: 'Authentication required or invalid credentials/token',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        Forbidden: {
          description: 'Permission denied',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        InternalServerError: {
          description: 'Internal server error',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      },
      schemas,
    },
  };
}

export { buildOpenApiSpec };
