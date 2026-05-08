import { SetMetadata } from '@nestjs/common';

/** Marker to opt a controller / handler out of the global `AuthGuard`. */
export const ALLOW_ANON_KEY = 'auth:allowAnon';

export const AllowAnon = (): MethodDecorator & ClassDecorator => SetMetadata(ALLOW_ANON_KEY, true);
