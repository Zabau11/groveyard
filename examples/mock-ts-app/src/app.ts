import { routes } from "./generated/routes.js";

export function listRoutes(): string[] {
  return routes.map((route) => `${route.id}:${route.path}`);
}

console.log(listRoutes());
