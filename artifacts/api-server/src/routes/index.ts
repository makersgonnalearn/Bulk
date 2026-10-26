import { Router, type IRouter } from "express";
import configRouter from "./config";
import healthRouter from "./health";
import vectorizerRouter from "./vectorizer";
import websiteDraftsRouter from "./website-drafts";

const router: IRouter = Router();

router.use(healthRouter);
router.use(configRouter);
// Before the vectorizer router: its Supabase auth applies to every request that reaches it.
router.use(websiteDraftsRouter);
router.use(vectorizerRouter);

export default router;
