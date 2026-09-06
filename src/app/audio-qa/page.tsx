import { notFound } from "next/navigation";
import Fixture from "./fixture";
export default function Page() { if (process.env.VERCEL_ENV !== "preview") notFound(); return <Fixture />; }
