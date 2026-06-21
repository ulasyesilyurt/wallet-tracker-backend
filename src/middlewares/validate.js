export function validate(schema) {
  return async (req, res, next) => {
    try {
      const parsed = await schema.parseAsync({
        body: req.body ?? {},
        params: req.params ?? {},
        query: req.query ?? {}
      });

      req.validated = parsed;
      next();
    } catch (error) {
      next(error);
    }
  };
}
