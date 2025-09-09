module.exports = (err, req, res, next) => {
    console.error(err.stack);

    res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal Server Error",
    });
};
