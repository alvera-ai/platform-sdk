import { Command } from 'commander';
import { type GlobalOpts, authedApi, bodyOption, readBody, resolveTenant, run } from './helpers.js';

export function register(program: Command): void {
  const workflows = program.command('workflows').description('Agentic workflows');

  workflows
    .command('list <datalake> [tenant]')
    .description('List workflow definitions in a datalake')
    .action(async (datalake: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.workflows.list(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
        );
        return data;
      });
    });

  workflows
    .command('get <datalake> <id> [tenant]')
    .description('Get a workflow by id')
    .action(async (datalake: string, id: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.workflows.get(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          id,
        );
        return data;
      });
    });

  bodyOption(workflows.command('create <datalake> [tenant]').description('Create a workflow'))
    .action(async (datalake: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.workflows.create(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  bodyOption(workflows.command('update <datalake> <id> [tenant]').description('Update a workflow'))
    .action(async (datalake: string, id: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.workflows.update(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          id,
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  workflows
    .command('delete <datalake> <id> [tenant]')
    .description('Delete a workflow')
    .action(async (datalake: string, id: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.workflows.delete(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          id,
        );
        return data;
      });
    });

  workflows
    .command('metadata <datalake> <id> [tenant]')
    .description('Get markdown metadata for a workflow')
    .action(async (datalake: string, id: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.workflows.metadata(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          id,
        );
        return data;
      });
    });

  bodyOption(
    workflows.command('execute <workflow-slug> [tenant]').description('Execute an agentic workflow'),
  )
    .action(async (workflowSlug: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.workflows.execute(
          resolveTenant(tenant, resolved.tenantSlug),
          workflowSlug,
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  bodyOption(
    workflows
      .command('run <workflow-slug> [tenant]')
      .description('Run a workflow across records matched by a SQL WHERE clause'),
  )
    .action(async (workflowSlug: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.workflows.run(
          resolveTenant(tenant, resolved.tenantSlug),
          workflowSlug,
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  workflows
    .command('batch-logs <workflow-slug> [tenant]')
    .description('List batch logs for a workflow')
    .action(async (workflowSlug: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.workflows.batchLogs.list(
          resolveTenant(tenant, resolved.tenantSlug),
          workflowSlug,
        );
        return data;
      });
    });

  workflows
    .command('batch-log <workflow-slug> <id> [tenant]')
    .description('Get a single batch log by id')
    .action(async (workflowSlug: string, id: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.workflows.batchLogs.get(
          resolveTenant(tenant, resolved.tenantSlug),
          workflowSlug,
          id,
        );
        return data;
      });
    });

  workflows
    .command('batch-log-start <workflow-slug> <id> [tenant]')
    .description('Start polling a batch log')
    .action(async (workflowSlug: string, id: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.workflows.batchLogs.start(
          resolveTenant(tenant, resolved.tenantSlug),
          workflowSlug,
          id,
        );
        return data;
      });
    });

  workflows
    .command('batch-log-stop <workflow-slug> <id> [tenant]')
    .description('Stop polling a batch log')
    .action(async (workflowSlug: string, id: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.workflows.batchLogs.stop(
          resolveTenant(tenant, resolved.tenantSlug),
          workflowSlug,
          id,
        );
        return data;
      });
    });

  workflows
    .command('batch-log-refresh <workflow-slug> <id> [tenant]')
    .description('Force-refresh a batch log')
    .action(async (workflowSlug: string, id: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.workflows.batchLogs.refresh(
          resolveTenant(tenant, resolved.tenantSlug),
          workflowSlug,
          id,
        );
        return data;
      });
    });

  workflows
    .command('workflow-logs <workflow-slug> [tenant]')
    .description('List execution logs for a workflow')
    .action(async (workflowSlug: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.workflows.workflowLogs.list(
          resolveTenant(tenant, resolved.tenantSlug),
          workflowSlug,
        );
        return data;
      });
    });

  workflows
    .command('workflow-log <workflow-slug> <id> [tenant]')
    .description('Get a single execution log by id')
    .option('--data-access-mode <mode>', 'regulated or unregulated')
    .action(async (workflowSlug: string, id: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.workflows.workflowLogs.get(
          resolveTenant(tenant, resolved.tenantSlug),
          workflowSlug,
          id,
          opts.dataAccessMode
            ? { dataAccessMode: opts.dataAccessMode as 'regulated' | 'unregulated' }
            : undefined,
        );
        return data;
      });
    });

  workflows
    .command('workflow-log-download <workflow-slug> <id> [tenant]')
    .description('Get a presigned download URL for an execution log')
    .action(async (workflowSlug: string, id: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.workflows.workflowLogs.download(
          resolveTenant(tenant, resolved.tenantSlug),
          workflowSlug,
          id,
        );
        return data;
      });
    });
}
