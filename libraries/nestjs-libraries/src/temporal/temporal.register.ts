import { Global, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';
import { Connection } from '@temporalio/client';

@Injectable()
export class TemporalRegister implements OnModuleInit {
  constructor(private _client: TemporalService) {}

  // Root cause of the 2026-09-15/16 backend boot hangs: this used to
  // await connection.operatorService.listSearchAttributes(...) directly,
  // with no deadline. It runs during Nest's provider-construction phase,
  // so a slow-to-respond Temporal (e.g. mid-restart, its WorkflowService
  // already SERVING per the healthcheck but OperatorService not yet)
  // blocked the entire backend boot indefinitely. Both calls are now
  // wrapped with an explicit 10s deadline and log-and-continue on
  // timeout — registering these search attributes is idempotent
  // maintenance, not something worth blocking the app from serving on.
  private withDeadline<T>(promise: Promise<T>, label: string, ms = 10000): Promise<T | undefined> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      ),
    ]).catch((err) => {
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
