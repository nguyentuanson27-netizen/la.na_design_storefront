import type { Metadata } from "next";
import { FLASH_DESCRIPTION } from "./flash-sale.ts";
export const SALE_TITLE="Sale"; export const SALE_DESCRIPTION=FLASH_DESCRIPTION;
export function buildSaleMetadata():Metadata{return{title:SALE_TITLE,description:SALE_DESCRIPTION};}
