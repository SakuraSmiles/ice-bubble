/**
 * Swagger UI 文档路由
 *
 * GET /api/docs              — Swagger UI 页面（需认证）
 * GET /api/docs/openapi.json — OpenAPI spec JSON
 *
 * /api/docs 在 auth middleware 之后注册，需要 Bearer Token。
 */

import { Router, Request, Response } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';

// CJS require — swagger-ui-express 是 CJS 包
// eslint-disable-next-line @typescript-eslint/no-var-requires
const swaggerUiExpress = require('swagger-ui-express');

export function createDocsRouter(): Router {
  const router = Router();

  // 读取并解析 OpenAPI spec
  const yamlContent = readFileSync(join(__dirname, 'openapi.yaml'), 'utf-8');

  // 动态加载 js-yaml（项目已有 js-yaml 依赖）转换 YAML → JSON object
  let openApiObject: any = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const jsYaml = require('js-yaml');
    openApiObject = jsYaml.load(yamlContent);
  } catch {
    // 如果 js-yaml 不可用，直接传 yaml 文本（Swagger UI 仍然可以工作）
    openApiObject = yamlContent;
  }

  // OpenAPI spec JSON endpoint
  router.get('/openapi.json', (_req: Request, res: Response) => {
    res.json(openApiObject);
  });

  // Swagger UI
  router.use(
    '/',
    swaggerUiExpress.serve,
    swaggerUiExpress.setup(openApiObject, {
      swaggerOptions: {
        url: '/api/docs/openapi.json',
        docExpansion: 'list',
      },
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'ice-bubble Admin API Docs',
    })
  );

  return router;
}
