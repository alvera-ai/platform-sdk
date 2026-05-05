import { Command, Option } from 'commander';
import { type GlobalOpts, authedApi, bodyOption, readBody, resolveTenant, run } from './helpers.js';

export function register(program: Command): void {
  // -- tenants ----------------------------------------------------------------
  const tenants = program.command('tenants').description('Manage tenants');

  tenants
    .command('list')
    .description('List tenants accessible to the current session')
    .action(async () => {
      await run(async () => {
        const { api } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.tenants.list();
        return data;
      });
    });

  // -- datalakes --------------------------------------------------------------
  const datalakes = program.command('datalakes').description('Manage datalakes');

  datalakes
    .command('list [tenant]')
    .description('List datalakes for a tenant')
    .action(async (tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.datalakes.list(resolveTenant(tenant, resolved.tenantSlug));
        return data;
      });
    });

  datalakes
    .command('get <id> [tenant]')
    .description('Get a datalake by id')
    .action(async (id: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.datalakes.get(resolveTenant(tenant, resolved.tenantSlug), id);
        return data;
      });
    });

  bodyOption(datalakes.command('create [tenant]').description('Create a datalake'))
    .action(async (tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.datalakes.create(
          resolveTenant(tenant, resolved.tenantSlug),
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  datalakes
    .command('metadata <datalake> [tenant]')
    .description('Get markdown metadata for a datalake')
    .action(async (datalake: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.datalakes.metadata(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
        );
        return data;
      });
    });

  datalakes
    .command('upload-link <datalake> <filename> [tenant]')
    .description('Create a presigned upload link for a datalake')
    .addOption(
      new Option('--content-type <type>', 'MIME type of the file')
        .choices(['application/x-ndjson', 'text/csv'])
        .default('application/x-ndjson'),
    )
    .action(
      async (
        datalake: string,
        filename: string,
        tenant: string | undefined,
        opts: Record<string, string>,
      ) => {
        await run(async () => {
          const { api, resolved } = authedApi(program.opts<GlobalOpts>());
          const { data } = await api.datalakes.createUploadLink(
            resolveTenant(tenant, resolved.tenantSlug),
            datalake,
            {
              content_type: opts.contentType as 'application/x-ndjson' | 'text/csv',
              filename,
            },
          );
          return data;
        });
      },
    );

  datalakes
    .command('download-link <datalake> <bucket> <key> [tenant]')
    .description('Create a presigned download URL for a datalake object')
    .action(
      async (
        datalake: string,
        bucket: string,
        key: string,
        tenant: string | undefined,
      ) => {
        await run(async () => {
          const { api, resolved } = authedApi(program.opts<GlobalOpts>());
          const { data } = await api.datalakes.createDownloadLink(
            resolveTenant(tenant, resolved.tenantSlug),
            datalake,
            { bucket, key },
          );
          return data;
        });
      },
    );

  // -- data-sources -----------------------------------------------------------
  const dataSources = program.command('data-sources').description('Manage data sources');

  dataSources
    .command('list <datalake> [tenant]')
    .description('List data sources in a datalake')
    .action(async (datalake: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.dataSources.list(resolveTenant(tenant, resolved.tenantSlug), datalake);
        return data;
      });
    });

  bodyOption(dataSources.command('create <datalake> [tenant]').description('Create a data source'))
    .action(async (datalake: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.dataSources.create(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  bodyOption(dataSources.command('update <datalake> <id> [tenant]').description('Update a data source'))
    .action(async (datalake: string, id: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.dataSources.update(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          id,
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  // -- tools ------------------------------------------------------------------
  const tools = program.command('tools').description('Manage tools');

  tools
    .command('list [tenant]')
    .description('List tools for a tenant')
    .action(async (tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.tools.list(resolveTenant(tenant, resolved.tenantSlug));
        return data;
      });
    });

  tools
    .command('get <id> [tenant]')
    .description('Get a tool by id')
    .action(async (id: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.tools.get(resolveTenant(tenant, resolved.tenantSlug), id);
        return data;
      });
    });

  bodyOption(tools.command('create [tenant]').description('Create a tool'))
    .action(async (tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.tools.create(
          resolveTenant(tenant, resolved.tenantSlug),
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  bodyOption(tools.command('update <id> [tenant]').description('Update a tool'))
    .action(async (id: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.tools.update(
          resolveTenant(tenant, resolved.tenantSlug),
          id,
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  tools
    .command('delete <id> [tenant]')
    .description('Delete a tool')
    .action(async (id: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.tools.delete(resolveTenant(tenant, resolved.tenantSlug), id);
        return data;
      });
    });

  // -- generic-tables ---------------------------------------------------------
  const genericTables = program.command('generic-tables').description('Manage generic tables');

  genericTables
    .command('list <datalake> [tenant]')
    .description('List generic tables in a datalake')
    .action(async (datalake: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.genericTables.list(resolveTenant(tenant, resolved.tenantSlug), datalake);
        return data;
      });
    });

  bodyOption(genericTables.command('create <datalake> [tenant]').description('Create a generic table'))
    .action(async (datalake: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.genericTables.create(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          readBody(opts.body, opts.bodyFile) as never,
        );
        return data;
      });
    });

  // -- action-status-updaters -------------------------------------------------
  const updaters = program.command('action-status-updaters').description('Manage action status updaters');

  updaters
    .command('list [tenant]')
    .description('List action status updaters')
    .action(async (tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.actionStatusUpdaters.list(resolveTenant(tenant, resolved.tenantSlug));
        return data;
      });
    });

  bodyOption(updaters.command('create [tenant]').description('Create an action status updater'))
    .action(async (tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.actionStatusUpdaters.create(
          resolveTenant(tenant, resolved.tenantSlug),
          readBody(opts.body, opts.bodyFile) as never,
        );
        return data;
      });
    });

  bodyOption(updaters.command('update <id> [tenant]').description('Update an action status updater'))
    .action(async (id: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.actionStatusUpdaters.update(
          resolveTenant(tenant, resolved.tenantSlug),
          id,
          readBody(opts.body, opts.bodyFile) as never,
        );
        return data;
      });
    });

  // -- ai-agents --------------------------------------------------------------
  const aiAgents = program.command('ai-agents').description('Manage AI agents');

  aiAgents
    .command('list <datalake> [tenant]')
    .description('List AI agents in a datalake')
    .action(async (datalake: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.aiAgents.list(resolveTenant(tenant, resolved.tenantSlug), datalake);
        return data;
      });
    });

  aiAgents
    .command('get <datalake> <id> [tenant]')
    .description('Get an AI agent by id')
    .action(async (datalake: string, id: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.aiAgents.get(resolveTenant(tenant, resolved.tenantSlug), datalake, id);
        return data;
      });
    });

  bodyOption(aiAgents.command('create <datalake> [tenant]').description('Create an AI agent'))
    .action(async (datalake: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.aiAgents.create(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          readBody(opts.body, opts.bodyFile) as never,
        );
        return data;
      });
    });

  bodyOption(aiAgents.command('update <datalake> <id> [tenant]').description('Update an AI agent'))
    .action(async (datalake: string, id: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.aiAgents.update(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          id,
          readBody(opts.body, opts.bodyFile) as never,
        );
        return data;
      });
    });

  aiAgents
    .command('delete <datalake> <id> [tenant]')
    .description('Delete an AI agent')
    .action(async (datalake: string, id: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.aiAgents.delete(resolveTenant(tenant, resolved.tenantSlug), datalake, id);
        return data;
      });
    });

  // -- datasets ---------------------------------------------------------------
  const datasets = program.command('datasets').description('Search datasets');

  datasets
    .command('search <dataset>')
    .description('Search a dataset (e.g. patient, member)')
    .option('--datalake-id <id>', 'restrict to a specific datalake')
    .option('--data-access-mode <mode>', 'regulated or unregulated')
    .option('--page <n>', 'page number', (v: string) => Number(v))
    .option('--page-size <n>', 'results per page (max 100)', (v: string) => Number(v))
    .action(async (dataset: string, opts: Record<string, unknown>) => {
      await run(async () => {
        const { api } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.datasets.search(dataset, {
          datalakeId: opts.datalakeId as string | undefined,
          dataAccessMode: opts.dataAccessMode as 'regulated' | 'unregulated' | undefined,
          page: opts.page as number | undefined,
          pageSize: opts.pageSize as number | undefined,
        });
        return data;
      });
    });

  datasets
    .command('metadata <dataset-type>')
    .description('Get markdown schema metadata for a dataset type')
    .option('--datalake-id <id>', 'restrict to a specific datalake')
    .option('--generic-table-id <id>', 'required when dataset-type is generic_table')
    .action(async (datasetType: string, opts: Record<string, string>) => {
      await run(async () => {
        const { api } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.datasets.metadata(datasetType, {
          datalakeId: opts.datalakeId,
          genericTableId: opts.genericTableId,
        });
        return data;
      });
    });

  // -- mdm --------------------------------------------------------------------
  const mdm = program.command('mdm').description('Master data management');

  bodyOption(
    mdm.command('verify <datalake> [tenant]').description('Fuzzy-verify an identity against MDM'),
  )
    .action(async (datalake: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.mdm.verify(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  // -- interoperability-contracts --------------------------------------------
  const interop = program
    .command('interoperability-contracts')
    .alias('interop')
    .description('Manage interoperability contracts');

  interop
    .command('list <datalake> [tenant]')
    .description('List interoperability contracts in a datalake')
    .action(async (datalake: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.interoperabilityContracts.list(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
        );
        return data;
      });
    });

  interop
    .command('get <datalake> <slug> [tenant]')
    .description('Get a contract by slug')
    .action(async (datalake: string, slug: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.interoperabilityContracts.get(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          slug,
        );
        return data;
      });
    });

  bodyOption(interop.command('create <datalake> [tenant]').description('Create a contract'))
    .action(async (datalake: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.interoperabilityContracts.create(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  bodyOption(interop.command('update <datalake> <slug> [tenant]').description('Update a contract'))
    .action(async (datalake: string, slug: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.interoperabilityContracts.update(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          slug,
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  interop
    .command('delete <datalake> <slug> [tenant]')
    .description('Delete a contract')
    .action(async (datalake: string, slug: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.interoperabilityContracts.delete(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          slug,
        );
        return data;
      });
    });

  interop
    .command('metadata <datalake> <slug> [tenant]')
    .description('Get markdown metadata for a contract')
    .action(async (datalake: string, slug: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.interoperabilityContracts.metadata(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          slug,
        );
        return data;
      });
    });

  bodyOption(
    interop
      .command('run <datalake> <slug> [tenant]')
      .description('Execute a contract against a raw source row'),
  )
    .action(async (datalake: string, slug: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.interoperabilityContracts.run(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          slug,
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  // -- connected-apps ---------------------------------------------------------
  const connectedApps = program.command('connected-apps').description('Manage connected apps');

  connectedApps
    .command('list <datalake> [tenant]')
    .description('List connected apps in a datalake')
    .action(async (datalake: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.connectedApps.list(resolveTenant(tenant, resolved.tenantSlug), datalake);
        return data;
      });
    });

  connectedApps
    .command('get <datalake> <id> [tenant]')
    .description('Get a connected app by id')
    .action(async (datalake: string, id: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.connectedApps.get(resolveTenant(tenant, resolved.tenantSlug), datalake, id);
        return data;
      });
    });

  bodyOption(connectedApps.command('create <datalake> [tenant]').description('Create a connected app'))
    .action(async (datalake: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.connectedApps.create(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  bodyOption(connectedApps.command('update <datalake> <id> [tenant]').description('Update a connected app'))
    .action(async (datalake: string, id: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.connectedApps.update(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          id,
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  connectedApps
    .command('sync-routes <datalake> <id> [tenant]')
    .description('Trigger a sync of routes for a connected app')
    .action(async (datalake: string, id: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.connectedApps.syncRoutes(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          id,
        );
        return data;
      });
    });

  bodyOption(
    connectedApps
      .command('resolve-page <slug> [tenant]')
      .description('Resolve a connected app page (tenant-scoped, by slug)'),
  )
    .action(async (slug: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.connectedApps.resolvePage(
          resolveTenant(tenant, resolved.tenantSlug),
          slug,
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  bodyOption(
    connectedApps
      .command('update-message-tracking <slug> [tenant]')
      .description('Update page message tracking for a connected app'),
  )
    .action(async (slug: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.connectedApps.updateMessageTracking(
          resolveTenant(tenant, resolved.tenantSlug),
          slug,
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  // -- data-activation-clients -----------------------------------------------
  const dac = program.command('data-activation-clients').description('Manage data activation clients');

  dac
    .command('list <datalake> [tenant]')
    .description('List data activation clients in a datalake')
    .action(async (datalake: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.dataActivationClients.list(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
        );
        return data;
      });
    });

  dac
    .command('get <datalake> <slug> [tenant]')
    .description('Get a data activation client by slug')
    .action(async (datalake: string, slug: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.dataActivationClients.get(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          slug,
        );
        return data;
      });
    });

  bodyOption(dac.command('create <datalake> [tenant]').description('Create a data activation client'))
    .action(async (datalake: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.dataActivationClients.create(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  bodyOption(dac.command('update <datalake> <slug> [tenant]').description('Update a data activation client'))
    .action(async (datalake: string, slug: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.dataActivationClients.update(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          slug,
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  dac
    .command('delete <datalake> <slug> [tenant]')
    .description('Delete a data activation client')
    .action(async (datalake: string, slug: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.dataActivationClients.delete(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          slug,
        );
        return data;
      });
    });

  dac
    .command('metadata <datalake> <slug> [tenant]')
    .description('Get markdown metadata for a data activation client')
    .action(async (datalake: string, slug: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.dataActivationClients.metadata(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          slug,
        );
        return data;
      });
    });

  bodyOption(
    dac
      .command('run-manually <datalake> <slug> [tenant]')
      .description('Trigger a manual run (optional --body for tool_call override)'),
  )
    .action(async (datalake: string, slug: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const body = opts.body || opts.bodyFile ? readBody(opts.body, opts.bodyFile) : undefined;
        const { data } = await api.dataActivationClients.runManually(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          slug,
          body,
        );
        return data;
      });
    });

  bodyOption(dac.command('ingest <datalake> <slug> [tenant]').description('Ingest a JSON payload'))
    .action(async (datalake: string, slug: string, tenant: string | undefined, opts: Record<string, string>) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.dataActivationClients.ingest(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          slug,
          readBody(opts.body, opts.bodyFile),
        );
        return data;
      });
    });

  dac
    .command('ingest-file <datalake> <slug> <key> [tenant]')
    .description('Ingest a previously uploaded file (key from upload-link)')
    .action(async (datalake: string, slug: string, key: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.dataActivationClients.ingestFile(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          slug,
          { key },
        );
        return data;
      });
    });

  dac
    .command('logs <datalake> <slug> [tenant]')
    .description('List execution logs for a data activation client')
    .action(async (datalake: string, slug: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.dataActivationClients.logs.list(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          slug,
        );
        return data;
      });
    });

  dac
    .command('log-get <datalake> <slug> <id> [tenant]')
    .description('Get a single execution log by id')
    .action(async (datalake: string, slug: string, id: string, tenant: string | undefined) => {
      await run(async () => {
        const { api, resolved } = authedApi(program.opts<GlobalOpts>());
        const { data } = await api.dataActivationClients.logs.get(
          resolveTenant(tenant, resolved.tenantSlug),
          datalake,
          slug,
          id,
        );
        return data;
      });
    });
}
