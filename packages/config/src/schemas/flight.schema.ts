/**
 * Python Flight (gRPC) target for NestJS clients.
 */

export interface FlightConfig {
  readonly target: string;
  readonly port: number;
}

export const DEFAULT_FLIGHT_CONFIG: FlightConfig = {
  target: '127.0.0.1:8815',
  port: 8815,
};

export function flightConfig(overrides: Partial<FlightConfig> = {}): FlightConfig {
  return { ...DEFAULT_FLIGHT_CONFIG, ...overrides };
}
