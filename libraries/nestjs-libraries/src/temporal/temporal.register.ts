import { Global, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';
import { Connection } from '@temporalio/client';

@Injectable()
export class TemporalRegister implements OnModuleInit {
  constructor(private _client: TemporalService) {}

  // This used to await connection.operatorService.listSearchAttributes(...)
  // directly, with no deadline at all — a real, verified bug regardless
  // of whether it's the cause of the 2026-09-15/16 boot hangs. It is NOT
  // confirmed as that root cause: onModuleInit hooks run only after
  // Nest's provider-construction phase has fully completed for the
  // whole application, not during it, and the hang evidence (pm2 logs
  // showing nothing at all after the shell's own start-command echo —
  // not even Nest's first log line) doesn't establish that construction
  // ever finished. The actual hang could be in module loading, in
  // pre-Nest process startup, or in nestjs-temporal-core's
  // TEMPORAL_CONNECTION provider factory (a construction-phase, not
  // onModuleInit, async call — see the backlog note in this PR). Fixing
  // this regardless: registering these search attributes is idempotent
  // maintenance, not something worth blocking the app from serving on
  // even in the case where this specific call turns out to be slow.
  private withDeadline<T>(promise: Promise<T>, label: string, ms = 10000): Promise<T | undefined> {
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout])
      .finally(() => clearTimeout(timeoutHandle))
      .catch((err) => {
        console.error(`[startup] TemporalRegister.onModuleInit: ${err.message} — continuing without ${label}`);
        return undefined;
      });
  }

  async onModuleInit(): Promise<void> {
    if (process.env.TEMPORAL_TLS === 'true') {
      return;
    }
    console.log(`[startup] ${Date.now()} TemporalRegister.onModuleInit start`);
    const connection = this._client?.client?.getRawClient()
      ?.connection as Connection;

    const listResult = await this.withDeadline(
      connection.operatorService.listSearchAttributes({
        namespace: process.env.TEMPORAL_NAMESPACE || 'default',
      }),
      'listSearchAttributes'
    );
    console.log(`[startup] ${Date.now()} TemporalRegister.onModuleInit: listSearchAttributes settled`);

    const customAttributes = listResult?.customAttributes || {};
    const neededAttribute = ['organizationId', 'postId'];
    const missingAttributes = neededAttribute.filter(
      (attr) => !customAttributes[attr]
    );

    if (missingAttributes.length > 0) {
      await this.withDeadline(
        connection.operatorService.addSearchAttributes({
          namespace: process.env.TEMPORAL_NAMESPACE || 'default',
          searchAttributes: missingAttributes.reduce((all, current) => {
            // @ts-ignore
            all[current] = 1;
            return all;
          }, {}),
        }),
        'addSearchAttributes'
      );
    }
    console.log(`[startup] ${Date.now()} TemporalRegister.onModuleInit done`);
  }
}

@Global()
@Module({
  imports: [],
  controllers: [],
  providers: [TemporalRegister],
  get exports() {
    return this.providers;
  },
})
export class TemporalRegisterMissingSearchAttributesModule {}
