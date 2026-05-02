/**
 * Loads `flight.proto` once and exposes the strongly-typed gRPC service
 * client constructor. Uses `@grpc/proto-loader` so the build does not
 * require a `protoc` step — the proto is parsed at process start.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  loadPackageDefinition,
  type GrpcObject,
  type ServiceClientConstructor,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';

const PROTO_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'flight.proto');

const packageDef = loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String, // int64 → string so we don't fight BigInt vs number
  enums: String, // enums as their string name
  defaults: true,
  oneofs: true,
});

const root = loadPackageDefinition(packageDef);
const arrow = root['arrow'] as GrpcObject;
const flight = arrow['flight'] as GrpcObject;
const protocol = flight['protocol'] as GrpcObject;
const FlightServiceCtor = protocol['FlightService'] as ServiceClientConstructor;

if (typeof FlightServiceCtor !== 'function') {
  throw new Error('flight.proto did not yield a FlightService client constructor');
}

export const FlightService = FlightServiceCtor;
