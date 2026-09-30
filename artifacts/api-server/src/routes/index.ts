import { Router, type IRouter } from "express";
import configRouter from "./config";
import healthRouter from "./health";
import vectorizerRouter from "./vectorizer";

const router: IRouter = Router();

router.use(healthRouter);
router.use(configRouter);
router.use(vectorizerRouter);

export default router;
