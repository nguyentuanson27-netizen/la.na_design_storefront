import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";

import { readAuthServerConfig } from "./config.ts";
import { BRAND } from "../brand/index.ts";
import { prisma } from "../db/prisma.ts";

const config = readAuthServerConfig();

export const auth = betterAuth({
  appName: BRAND.identity.name,
  baseURL: config.baseURL,
  secret: config.secret,
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  rateLimit: {
    storage: "database",
    modelName: "rateLimit",
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },
  user: {
    additionalFields: {
      role: {
        type: ["CUSTOMER", "ADMIN"],
        required: false,
        defaultValue: "CUSTOMER",
        input: false,
      },
    },
  },
  ...(config.ipAddressHeader
    ? {
        advanced: {
          ipAddress: {
            ipAddressHeaders: [config.ipAddressHeader],
          },
        },
      }
    : {}),
});
