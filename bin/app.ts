#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { TaskApiStack } from '../lib/task-api-stack';

const app = new App();

const stack = new TaskApiStack(app, 'TaskApiStack', {
  jwtIssuer: process.env.JWT_ISSUER ?? 'https://example-idp.invalid/',
  jwtAudience: (process.env.JWT_AUDIENCE ?? 'task-api').split(','),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173').split(','),
  reservedConcurrency: Number(process.env.RESERVED_CONCURRENCY ?? 50),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

Tags.of(stack).add('service', 'task-api');
Tags.of(stack).add('owner', 'platform');
Tags.of(stack).add('dataClassification', 'confidential');
