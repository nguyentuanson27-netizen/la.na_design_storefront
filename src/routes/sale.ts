import { notFound } from "next/navigation";
import { connection } from "next/server";
import { listConfiguredFlashSalePage, readConfiguredNextFlashSaleBoundary } from "@/commerce/storefront-catalog-runtime";
import { parseStorefrontDiscoverySearchParams, type StorefrontDiscoverySearchParams } from "@/commerce/storefront-discovery";
import { resolveStorefrontPromotionRefresh } from "@/commerce/storefront-promotion-freshness";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";
import { sealRoute, type RouteHandle } from "./core.tsx";
import { buildFlashSaleViewModel, type FlashSaleViewModel } from "./flash-sale-model.ts";
import { SALE_TITLE } from "./metadata/sale.ts";
export const SALE_PAGE_SIZE=24; export type SaleRouteProps=Readonly<{searchParams:Promise<StorefrontDiscoverySearchParams>}>;
export async function loadSaleRoute({searchParams}:SaleRouteProps):Promise<RouteHandle<FlashSaleViewModel>>{await connection();const now=new Date();let discovery:ReturnType<typeof parseStorefrontDiscoverySearchParams>;let page:Awaited<ReturnType<typeof listConfiguredFlashSalePage>>;let boundary:Awaited<ReturnType<typeof readConfiguredNextFlashSaleBoundary>>;try{discovery=parseStorefrontDiscoverySearchParams(await searchParams);[page,boundary]=await Promise.all([listConfiguredFlashSalePage({discovery,pageSize:SALE_PAGE_SIZE,now}),readConfiguredNextFlashSaleBoundary(now)]);}catch(error){if(error instanceof RangeError)notFound();throw error;}const tracking=buildProductListTracking({products:page.products,list:{listId:"sale",listName:SALE_TITLE}});const model=buildFlashSaleViewModel({products:page.products,totalCount:page.totalCount,totalPages:page.totalPages,page:page.page,pageSize:SALE_PAGE_SIZE,selectEventBySlug:tracking.selectEventBySlug});const data:Object & FlashSaleViewModel=Object.freeze({...model,previousHref:model.previousHref?.replace("/flash-sale","/sale")??null,nextHref:model.nextHref?.replace("/flash-sale","/sale")??null});return sealRoute({data,refreshAfterMs:resolveStorefrontPromotionRefresh({now,nextBoundaryAt:boundary}).refreshAfterMs,trackingEvent:tracking.listEvent,structuredData:[],pixelEvents:[]});}
