module.exports = (schema) => {
    return (req, res, next) => {
        try {
            const { error } = schema.validate(req.body, { abortEarly: false });
            if (error) {
                return res.status(400).json({
                    status: "error",
                    errors: error.details.map((err) => err.message),
                });
            }
            next();
        } catch (err) {
            next(err);
        }
    };
};
