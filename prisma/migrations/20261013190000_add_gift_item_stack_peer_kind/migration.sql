-- Gift & Quantity Promotions v1 (review finding F02): a gift campaign can be a stack peer.
--
-- FR-08 lets an operator say which programs a campaign may combine with, "legacy discounts and
-- other gifts" included. The peer kind enum named the three legacy kinds and QUANTITY_TIER only, so
-- a gift campaign could neither be named by a peer nor name another gift campaign.
--
-- Additive and irreversible only in the harmless sense: an enum value that no row uses can stay.
-- No existing row, constraint or index changes; nothing writes the new value until the admin write
-- contract for gifts does, and that is behind LA_GIFT_QUANTITY_PROMOTIONS_ENABLED.
ALTER TYPE "GiftQuantityStackPeerKind" ADD VALUE IF NOT EXISTS 'GIFT_ITEM';
