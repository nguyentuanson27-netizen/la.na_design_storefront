import type { Metadata } from "next";
import type { CategoryDestination } from "../category.tsx";
export function buildCategoryMetadata(destination:CategoryDestination):Metadata{return{title:destination.label};}
