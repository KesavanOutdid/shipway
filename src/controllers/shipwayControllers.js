const { connectToDatabase } = require("../config/db");
require("dotenv").config();
const axios = require("axios");
const logger = require("../utils/logger");

// -------------------------------------------------------------
// Shipway Auth
// -------------------------------------------------------------
const SHIPWAY_USERNAME = process.env.SHIPWAY_USERNAME;
const SHIPWAY_PASSWORD = process.env.SHIPWAY_PASSWORD;
const token = Buffer.from(`${SHIPWAY_USERNAME}:${SHIPWAY_PASSWORD}`).toString("base64");

// -------------------------------------------------------------
// Utility: Validate Required Fields
// -------------------------------------------------------------
const validateFields = (payload, requiredFields) => {
    const missing = [];
    requiredFields.forEach((field) => {
        if (
            payload[field] === undefined ||
            payload[field] === null ||
            payload[field] === ""
        ) {
            missing.push(field);
        }
    });
    return missing;
};

// Push Orders
const pushOrders = async (req, res) => {
    const payload = req.body;
    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    // Validate mandatory fields
    const requiredFields = ["order_id", "products", "payment_type", "shipping_country", "shipping_phone", "shipping_zipcode"];
    const missingFields = validateFields(payload, requiredFields);

    if (missingFields.length > 0) {
        return res.status(400).json({
            success: false,
            error: true,
            message: `Missing required fields: ${missingFields.join(", ")}`,
        });
    }

    let db;
    try {
        db = await connectToDatabase();
    } catch (err) {
        logger.error(`DB Connection Failed: ${err.message}`);
        return res.status(500).json({
            success: false,
            error: true,
            message: "Database connection failed",
        });
    }

    try {
        // Check if order_id already exists
        const existingOrder = await db.collection("pushorder").findOne({ order_id: payload.order_id });

        if (existingOrder) {
            const isCancelled =
                existingOrder.cancel_response?.success === true ||
                existingOrder.status_message?.toLowerCase().includes("cancel");

            const isOnhold =
                existingOrder.onhold_response?.success === true ||
                existingOrder.status_message?.toLowerCase().includes("onhold");

            const isCancelShipment =
                existingOrder.awb_response?.success === false &&
                Array.isArray(existingOrder.awb_response?.error) &&
                existingOrder.awb_response.error.length > 0;

            if (!isCancelled && !isOnhold && !isCancelShipment) {
                return res.status(400).json({
                    success: false,
                    error: true,
                    message: `Order ID "${payload.order_id}" already exists and is active.`,
                });
            }
        }

        // Push order to Shipway
        const response = await axios.post(process.env.SHIPWAY_PUSHORDERS_URL, payload, { headers });

        const statusMessage = response.data?.message || "Order has been added successfully.";

        // Save order in MongoDB
        const orderDoc = {
            ...payload,
            created_at: new Date(),
            status_message: statusMessage,
            shipway_response: response.data || null,
        };

        await db.collection("pushorder").insertOne(orderDoc);

        logger.info(`Order pushed successfully: ${payload.order_id}`);

        return res.status(200).json({
            success: true,
            message: statusMessage,
            data: response.data,
        });
    } catch (err) {
        logger.error(`PushOrders Error: ${err.message}`);
        if (err.response) {
            return res.status(err.response.status).json({
                success: false,
                error: err.response.data,
            });
        }
        return res.status(500).json({
            success: false,
            error: err.message,
        });
    }
};

// Label Generation
const labelGeneration = async (req, res) => {
    const payload = req.body;
    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    // Validate mandatory fields
    const requiredFields = ["order_id", "carrier_id", "warehouse_id", "return_warehouse_id"];
    const missingFields = validateFields(payload, requiredFields);

    if (missingFields.length > 0) {
        return res.status(400).json({
            success: false,
            error: true,
            message: `Missing required fields: ${missingFields.join(", ")}`,
        });
    }

    let db;
    try {
        db = await connectToDatabase();
    } catch (err) {
        logger.error(`DB Connection Failed: ${err.message}`);
        return res.status(500).json({
            success: false,
            error: true,
            message: "Database connection failed",
        });
    }

    try {
        // Find existing order
        const existingOrder = await db.collection("pushorder").findOne({ order_id: payload.order_id });

        if (!existingOrder) {
            return res.status(404).json({
                success: false,
                error: true,
                message: `Order ID "${payload.order_id}" not found.`,
            });
        }

        // Check if AWB already exists
        if (existingOrder.awb_response?.success === true) {
            return res.status(400).json({
                success: false,
                error: true,
                message: "AWB already generated for this order.",
                awb_response: existingOrder.awb_response,
            });
        }

        // Update missing fields if necessary
        if (
            !existingOrder.carrier_id ||
            !existingOrder.warehouse_id ||
            !existingOrder.return_warehouse_id
        ) {
            await db.collection("pushorder").updateOne(
                { order_id: payload.order_id },
                {
                    $set: {
                        carrier_id: payload.carrier_id,
                        warehouse_id: payload.warehouse_id,
                        return_warehouse_id: payload.return_warehouse_id,
                        updated_at: new Date(),
                    },
                }
            );
        }

        // Call Shipway Label Generation API
        const response = await axios.post(process.env.SHIPWAY_LABELGENERATION_URL, payload, { headers });

        const awbResponse = response.data?.awb_response || {};
        const statusMessage = response.data?.message || "Label generated successfully.";

        // Save AWB response to DB
        await db.collection("pushorder").updateOne(
            { order_id: payload.order_id },
            {
                $set: {
                    status_message: statusMessage,
                    awb_response: awbResponse,
                    updated_at: new Date(),
                },
            }
        );

        logger.info(`Label generated successfully: ${payload.order_id}`);

        return res.status(200).json({
            success: true,
            message: statusMessage,
            awb_response: awbResponse,
        });
    } catch (err) {
        logger.error(`LabelGeneration Error: ${err.message}`);
        if (err.response) {
            return res.status(err.response.status).json({
                success: false,
                error: err.response.data,
            });
        }
        return res.status(500).json({
            success: false,
            error: err.message,
        });
    }
};

// Create Order Manifest
const CreateOrderManifest = async (req, res) => {
    const payload = req.body;
    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    // Step 1: Validate Input
    if (!payload.order_ids || !Array.isArray(payload.order_ids) || payload.order_ids.length === 0) {
        logger.warn("Validation failed: order_ids missing or invalid", { payload });
        return res.status(400).json({
            success: false,
            error: true,
            message: "order_ids is required and must be a non-empty array",
        });
    }

    let db;
    try {
        db = await connectToDatabase();
    } catch (err) {
        logger.error(`DB Connection Failed: ${err.message}`);
        return res.status(500).json({
            success: false,
            error: true,
            message: "Database connection failed",
        });
    }

    try {
        const orderIds = payload.order_ids;

        // Find existing orders
        const existingOrders = await db
            .collection("pushorder")
            .find({ order_id: { $in: orderIds } })
            .toArray();

        const alreadyManifested = existingOrders.filter(o => o.manifest_response);
        const alreadyManifestIds = alreadyManifested.map(o => ({
            order_id: o.order_id,
            manifest_ids: o.manifest_response?.["manifest ids"] || null,
        }));

        // Orders without manifest
        const newOrderIds = orderIds.filter(
            id => !alreadyManifested.some(o => o.order_id === id)
        );

        let manifestResponse = null;
        let statusMessage = "No new orders to manifest.";

        // If new orders exist → call Shipway API
        if (newOrderIds.length > 0) {
            try {
                const response = await axios.post(
                    process.env.SHIPWAY_CreateOrderManifest_URL,
                    { order_ids: newOrderIds },
                    { headers }
                );

                manifestResponse = response.data || null;
                statusMessage = manifestResponse?.message || "Manifest request completed.";

                // Save response in DB
                await db.collection("pushorder").updateMany(
                    { order_id: { $in: newOrderIds } },
                    {
                        $set: {
                            manifest_response: manifestResponse,
                            manifest_status_message: statusMessage,
                            updated_at: new Date(),
                        },
                    }
                );

                logger.info("Manifest created successfully", {
                    processed: newOrderIds,
                    response: manifestResponse,
                });
            } catch (apiErr) {
                logger.error("Shipway Manifest API Error", {
                    status: apiErr.response?.status,
                    data: apiErr.response?.data,
                });

                // Save error response in DB
                await db.collection("pushorder").updateMany(
                    { order_id: { $in: newOrderIds } },
                    {
                        $set: {
                            manifest_response: apiErr.response?.data || { message: apiErr.message },
                            manifest_status_message: "Manifest API failed",
                            updated_at: new Date(),
                        },
                    }
                );

                return res.status(apiErr.response?.status || 500).json({
                    success: false,
                    error: apiErr.response?.data || apiErr.message,
                });
            }
        }

        // Final response
        return res.status(200).json({
            success: true,
            message: statusMessage,
            "manifest ids": manifestResponse?.["manifest ids"] || null,
            skipped: alreadyManifestIds,
            processed: newOrderIds,
            manifest_response: manifestResponse,
        });
    } catch (err) {
        logger.error(`Unexpected Error in CreateOrderManifest: ${err.message}`);
        return res.status(500).json({
            success: false,
            error: err.message || "Internal Server Error",
        });
    }
};

// Create Pickup
const createPickup = async (req, res) => {
    const { order_ids, pickup_date, pickup_time, carrier_id, office_close_time, warehouse_id, return_warehouse_id, payment_type, ...restPayload } = req.body;

    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    // Step 1: Validate Input
    if (!Array.isArray(order_ids) || order_ids.length === 0) {
        logger.warn("Validation failed: order_ids missing or invalid", { body: req.body });
        return res.status(400).json({
            success: false,
            error: true,
            message: "order_ids is required and must be a non-empty array",
        });
    }

    const requiredFields = {
        pickup_date,
        pickup_time,
        carrier_id,
        office_close_time,
        warehouse_id,
        return_warehouse_id,
        payment_type
    };

    for (const [field, value] of Object.entries(requiredFields)) {
        if (value === undefined || value === null || value === "") {
            logger.warn(`Validation failed: missing ${field}`, { body: req.body });
            return res.status(400).json({
                success: false,
                error: true,
                message: `${field} is required`,
            });
        }
    }

    let db;
    try {
        db = await connectToDatabase();
    } catch (err) {
        logger.error(`DB Connection Failed: ${err.message}`);
        return res.status(500).json({
            success: false,
            error: true,
            message: "Database connection failed",
        });
    }

    const results = [];
    for (const orderId of order_ids) {
        try {
            // Check if order exists
            const existingOrder = await db.collection("pushorder").findOne({ order_id: orderId });
            if (!existingOrder) {
                results.push({
                    order_id: orderId,
                    success: false,
                    message: "Order not found in pushorder",
                });
                continue;
            }

            // Skip if already has pickup response
            if (existingOrder.createPickupResponse) {
                results.push({
                    order_id: orderId,
                    success: false,
                    message: "Pickup already created for this order",
                });
                continue;
            }

            // Call Shipway API with only this order_id
            const singlePayload = { ...restPayload, order_ids: [orderId], pickup_date, pickup_time, carrier_id, office_close_time, warehouse_id, return_warehouse_id, payment_type };

            const response = await axios.post(process.env.SHIPWAY_CREATEPICKUP_URL, singlePayload, { headers });

            const pickupResponse = response.data;
            const statusMessage = pickupResponse?.message || "Pickup request processed.";

            // Save in pushorder for this order only
            await db.collection("pushorder").updateOne(
                { order_id: orderId },
                {
                    $set: {
                        createPickupData: singlePayload,
                        createPickupResponse: pickupResponse,
                        pickup_status_message: statusMessage,
                        updated_at: new Date(),
                    },
                }
            );

            logger.info("Pickup created successfully", { order_id: orderId, response: pickupResponse });

            results.push({
                order_id: orderId,
                success: true,
                message: statusMessage,
                response: pickupResponse,
            });
        } catch (err) {
            // Handle errors individually for each order
            if (err.response) {
                logger.error(`Shipway API Error for ${orderId}`, { status: err.response.status, data: err.response.data });

                await db.collection("pushorder").updateOne(
                    { order_id: orderId },
                    {
                        $set: {
                            createPickupData: { ...restPayload, order_ids: [orderId], pickup_date, pickup_time, carrier_id, office_close_time, warehouse_id, return_warehouse_id, payment_type },
                            createPickupResponse: err.response.data,
                            pickup_status_message: "Pickup API failed",
                            updated_at: new Date(),
                        },
                    }
                );

                results.push({
                    order_id: orderId,
                    success: false,
                    message: err.response.data?.message || "Shipway API failed",
                    response: err.response.data,
                });
            } else {
                logger.error(`Request Error for ${orderId}: ${err.message}`);

                results.push({
                    order_id: orderId,
                    success: false,
                    message: err.message,
                });
            }
        }
    }

    // Final aggregated response
    return res.status(200).json({
        success: true,
        results,
    });
};

// OnholdOrders
const OnholdOrders = async (req, res) => {
    const { order_ids } = req.body;
    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    // Validate request body
    if (!Array.isArray(order_ids) || order_ids.length === 0) {
        logger.error("OnholdOrders: order_ids missing or invalid");
        return res.status(400).json({
            success: false,
            error: true,
            message: "order_ids must be a non-empty array",
        });
    }

    let db;
    try {
        db = await connectToDatabase();
    } catch (err) {
        logger.error("OnholdOrders: Database connection failed", err);
        return res.status(500).json({
            success: false,
            error: true,
            message: "Database connection failed",
        });
    }

    const finalResponses = [];

    try {
        for (const orderId of order_ids) {
            try {
                const existingOrder = await db.collection("pushorder").findOne({ order_id: orderId });

                // Not found
                if (!existingOrder) {
                    finalResponses.push({
                        order_id: orderId,
                        success: false,
                        error: true,
                        message: "Order not found in database",
                    });
                    continue;
                }

                // Already Onhold
                if (existingOrder.onhold_response?.success === true) {
                    finalResponses.push({
                        order_id: orderId,
                        success: false,
                        error: true,
                        message: "This order is already Onhold",
                        onhold_response: existingOrder.onhold_response,
                    });
                    continue;
                }

                // Call Shipway API
                const response = await axios.post(
                    process.env.SHIPWAY_OnholdOrders_URL,
                    { order_ids: [orderId] },
                    { headers }
                );

                let orderRes = Array.isArray(response.data) ? response.data[0] : response.data;

                // Override message → always "Onhold"
                if (orderRes.success === true) {
                    orderRes = { ...orderRes, message: "Onhold" };
                }

                // Update DB
                await db.collection("pushorder").updateOne(
                    { order_id: orderId },
                    {
                        $set: {
                            status_message: orderRes.message,
                            onhold_response: orderRes,
                            updated_at: new Date(),
                        },
                    }
                );

                finalResponses.push(orderRes);
            } catch (shipErr) {
                logger.error(`OnholdOrders: Shipway API failed for ${orderId}`, shipErr);

                const errorRes = {
                    order_id: orderId,
                    success: false,
                    error: true,
                    message: shipErr.response?.data?.message || "Shipway onhold failed",
                };

                await db.collection("pushorder").updateOne(
                    { order_id: orderId },
                    {
                        $set: {
                            status_message: errorRes.message,
                            onhold_response: errorRes,
                            updated_at: new Date(),
                        },
                    }
                );

                finalResponses.push(errorRes);
            }
        }

        // If all orders already Onhold
        const allOnhold = finalResponses.every(
            (res) => res.success === false && res.message === "This order is already Onhold"
        );

        if (allOnhold) {
            return res.status(400).json({
                success: false,
                error: true,
                message: "All provided orders are already Onhold",
                data: finalResponses,
            });
        }

        logger.info("OnholdOrders processed", { count: finalResponses.length });
        return res.status(200).json({ success: true, data: finalResponses });
    } catch (err) {
        logger.error("OnholdOrders: Fatal error", err);
        return res.status(500).json({
            success: false,
            error: true,
            message: err.message,
        });
    }
};

// CancelOrders
const CancelOrders = async (req, res) => {
    const { order_ids } = req.body;
    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    // Validate request body
    if (!Array.isArray(order_ids) || order_ids.length === 0) {
        logger.error("CancelOrders: order_ids missing or invalid");
        return res.status(400).json({
            success: false,
            error: true,
            message: "order_ids must be a non-empty array",
        });
    }

    let db;
    try {
        db = await connectToDatabase();
    } catch (err) {
        logger.error("CancelOrders: Database connection failed", err);
        return res.status(500).json({
            success: false,
            error: true,
            message: "Database connection failed",
        });
    }

    const finalResponses = [];

    try {
        for (const orderId of order_ids) {
            try {
                const existingOrder = await db.collection("pushorder").findOne({ order_id: orderId });

                // Not found
                if (!existingOrder) {
                    finalResponses.push({
                        order_id: orderId,
                        success: false,
                        error: true,
                        message: "Order not found in database",
                    });
                    continue;
                }

                // Already cancelled
                if (existingOrder.cancel_response?.success === true) {
                    finalResponses.push({
                        order_id: orderId,
                        success: false,
                        error: true,
                        message: "This order is already cancelled",
                        cancel_response: existingOrder.cancel_response,
                    });
                    continue;
                }

                // Call Shipway
                let cancelRes;
                try {
                    const response = await axios.post(
                        process.env.SHIPWAY_Cancelorders_URL,
                        { order_ids: [orderId] },
                        { headers }
                    );

                    cancelRes = Array.isArray(response.data) ? response.data[0] : response.data;

                    // Override message → "cancelled"
                    if (cancelRes.success === true) {
                        cancelRes = { ...cancelRes, message: "cancelled" };
                    }
                } catch (shipErr) {
                    logger.error(`CancelOrders: Shipway API failed for ${orderId}`, shipErr);

                    cancelRes = {
                        order_id: orderId,
                        success: false,
                        error: true,
                        message: shipErr.response?.data?.message || "Shipway cancel failed",
                    };
                }

                // Update DB
                await db.collection("pushorder").updateOne(
                    { order_id: orderId },
                    {
                        $set: {
                            status_message: cancelRes.message,
                            cancel_response: cancelRes,
                            updated_at: new Date(),
                        },
                    }
                );

                finalResponses.push(cancelRes);
            } catch (orderErr) {
                logger.error(`CancelOrders: Unexpected error for ${orderId}`, orderErr);

                finalResponses.push({
                    order_id: orderId,
                    success: false,
                    error: true,
                    message: orderErr.message,
                });
            }
        }

        logger.info("CancelOrders processed", { count: finalResponses.length });
        return res.status(200).json({
            success: true,
            data: finalResponses,
        });
    } catch (err) {
        logger.error("CancelOrders: Fatal error", err);
        return res.status(500).json({
            success: false,
            error: true,
            message: err.message,
        });
    }
};

// CancelShipment
const CancelShipment = async (req, res) => {
    const { awb_number } = req.body; // Expecting { awb_number: ["1333110020164"] }
    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    // Validate request body
    if (!Array.isArray(awb_number) || awb_number.length === 0) {
        logger.error("CancelShipment: awb_number missing or invalid");
        return res.status(400).json({
            success: false,
            error: true,
            message: "awb_number must be a non-empty array",
        });
    }

    let db;
    try {
        db = await connectToDatabase();
    } catch (err) {
        logger.error("CancelShipment: Database connection failed", err);
        return res.status(500).json({
            success: false,
            error: true,
            message: "Database connection failed",
        });
    }

    const results = [];

    try {
        for (const awb of awb_number) {
            try {
                // Find order by AWB
                const existingOrder = await db.collection("pushorder").findOne({
                    "awb_response.AWB": awb,
                });

                if (!existingOrder) {
                    results.push({
                        awb_number: awb,
                        success: false,
                        error: true,
                        message: "Valid AWB number not found",
                    });
                    continue;
                }

                // Already cancelled
                if (existingOrder.CancelShipment_response?.success === true) {
                    results.push({
                        awb_number: awb,
                        success: false,
                        error: true,
                        message: "This AWB is already canceled shipment",
                        CancelShipment_response: existingOrder.CancelShipment_response,
                    });
                    continue;
                }

                // Call Shipway CancelShipment API
                let cancelRes;
                try {
                    const response = await axios.post(
                        process.env.SHIPWAY_CancelShipment_URL,
                        { awb_number: [awb] },
                        { headers }
                    );

                    cancelRes = response.data;

                    // Force message → "canceled shipment"
                    if (cancelRes.success === true) {
                        cancelRes = { ...cancelRes, message: "canceled shipment" };
                    }
                } catch (shipErr) {
                    logger.error(`CancelShipment: Shipway API failed for ${awb}`, shipErr);

                    cancelRes = {
                        awb_number: awb,
                        success: false,
                        error: true,
                        message: shipErr.response?.data?.message || "Shipway CancelShipment failed",
                    };
                }

                // Save to DB
                await db.collection("pushorder").updateOne(
                    { "awb_response.AWB": awb },
                    {
                        $set: {
                            CancelShipment_response: cancelRes,
                            updated_at: new Date(),
                        },
                    }
                );

                results.push(cancelRes);
            } catch (orderErr) {
                logger.error(`CancelShipment: Unexpected error for ${awb}`, orderErr);

                results.push({
                    awb_number: awb,
                    success: false,
                    error: true,
                    message: orderErr.message,
                });
            }
        }

        logger.info("CancelShipment processed", { count: results.length });
        return res.status(200).json({
            success: true,
            data: results,
        });
    } catch (err) {
        logger.error("CancelShipment: Fatal error", err);
        return res.status(500).json({
            success: false,
            error: true,
            message: err.message,
        });
    }
};

// Get Orders from Shipway API
const getOrders = async (req, res) => {
    try {
        const url = process.env.SHIPWAY_GETORDERS_URL;

        logger.info("getOrders: Fetching orders from Shipway", { url });

        const response = await axios.get(url, {
            headers: {
                Authorization: `Basic ${token}`,
                "Content-Type": "application/json",
            },
        });

        logger.info("getOrders: Orders fetched successfully", {
            count: Array.isArray(response.data) ? response.data.length : 1,
        });

        return res.status(200).json(response.data);
    } catch (err) {
        if (err.response) {
            logger.error("getOrders: Shipway API error", {
                status: err.response.status,
                details: err.response.data || err.response.statusText,
            });

            return res.status(err.response.status).json({
                success: false,
                error: "Shipway API error",
                details: err.response.data || err.response.statusText,
            });
        }

        logger.error("getOrders: Internal error", { error: err.message });

        return res.status(500).json({
            success: false,
            error: err.message || "Internal Server Error",
        });
    }
};

// Get All Orders from Local DB
const getAllOrders = async (req, res) => {
    let db;
    try {
        db = await connectToDatabase();
        logger.info("getAllOrders: Database connection established");
    } catch (err) {
        logger.error("getAllOrders: Database connection failed", { error: err.message });
        return res.status(500).json({
            success: false,
            error: true,
            message: "Database connection failed",
        });
    }

    try {
        const orders = await db.collection("pushorder").find().toArray();

        if (!orders || orders.length === 0) {
            logger.warn("getAllOrders: No orders found in database");
            return res.status(200).json({
                success: false,
                error: true,
                message: "empty data",
                total_count: 0,
            });
        }

        logger.info("getAllOrders: Orders fetched successfully", { total_count: orders.length });

        return res.status(200).json({
            success: true,
            error: false,
            total_count: orders.length,
            data: orders,
        });
    } catch (err) {
        logger.error("getAllOrders: Query failed", { error: err.message });
        return res.status(500).json({
            success: false,
            error: true,
            message: err.message || "Internal Server Error",
            total_count: 0,
        });
    }
};

// NDR - InsertOrder
const InsertOrder = async (req, res) => {
    const payload = req.body;
    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    let db;
    try {
        db = await connectToDatabase();
        logger.info("InsertOrder: Database connection established");
    } catch (err) {
        logger.error("InsertOrder: Database connection failed", { error: err.message });
        return res.status(500).json({
            success: false,
            error: true,
            message: "Database connection failed",
        });
    }

    try {
        const { order_id, order_tracking_number } = payload;

        // Validate required fields
        if (!order_id || !order_tracking_number) {
            logger.warn("InsertOrder: Missing required fields", { payload });
            return res.status(400).json({
                success: false,
                error: true,
                message: "order_id and order_tracking_number are required",
            });
        }

        // Find latest order with this order_id
        const existingOrder = await db.collection("pushorder").findOne(
            { order_id },
            { sort: { created_at: -1 } }
        );

        if (!existingOrder) {
            logger.warn("InsertOrder: Order not found in DB", { order_id });
            return res.status(404).json({
                success: false,
                error: true,
                message: `Order ID "${order_id}" not found in database`,
            });
        }

        // Already Onhold
        if (existingOrder.onhold_response?.success === true) {
            logger.warn("InsertOrder: Order already Onhold", { order_id });
            return res.status(400).json({
                success: false,
                error: true,
                message: "This order is already Onhold",
                onhold_response: existingOrder.onhold_response,
            });
        }

        // Already Cancelled
        if (existingOrder.cancel_response?.success === true) {
            logger.warn("InsertOrder: Order already Cancelled", { order_id });
            return res.status(400).json({
                success: false,
                error: true,
                message: "This order is already Cancelled",
                cancel_response: existingOrder.cancel_response,
            });
        }

        // Already Cancelled Shipment
        if (existingOrder.cancel_shipment_response?.success === true) {
            logger.warn("InsertOrder: Order shipment already Cancelled", { order_id });
            return res.status(400).json({
                success: false,
                error: true,
                message: "This order shipment is already Cancelled",
                cancel_shipment_response: existingOrder.cancel_shipment_response,
            });
        }

        // Check AWB match
        const dbAwb = existingOrder?.awb_response?.AWB;
        if (!dbAwb || dbAwb !== order_tracking_number) {
            logger.warn("InsertOrder: Invalid order_tracking_number", {
                order_id,
                dbAwb,
                requestAwb: order_tracking_number,
            });
            return res.status(400).json({
                success: false,
                error: true,
                message: "not found or invalid order_tracking_number",
            });
        }

        // Call Shipway InsertOrder API
        logger.info("InsertOrder: Calling Shipway API", { order_id, order_tracking_number });

        let insertRes;
        try {
            const response = await axios.post(
                process.env.SHIPWAY_InsertOrder_URL,
                payload,
                { headers }
            );
            insertRes = response.data;
            logger.info("InsertOrder: Shipway API success", { order_id });
        } catch (apiErr) {
            logger.error("InsertOrder: Shipway API failed", {
                order_id,
                status: apiErr.response?.status,
                error: apiErr.response?.data || apiErr.message,
            });
            return res.status(apiErr.response?.status || 500).json({
                success: false,
                error: apiErr.response?.data || apiErr.message,
            });
        }

        // Save InsertOrder response in DB
        try {
            await db.collection("pushorder").updateOne(
                { _id: existingOrder._id },
                {
                    $set: {
                        insertorder_response: insertRes,
                        updated_at: new Date(),
                    },
                }
            );
            logger.info("InsertOrder: Response saved in DB", { order_id });
        } catch (dbErr) {
            logger.error("InsertOrder: Failed to save in DB", { order_id, error: dbErr.message });
        }

        return res.status(200).json({
            success: true,
            data: insertRes,
        });
    } catch (err) {
        logger.error("InsertOrder: Internal error", { error: err.message });
        return res.status(err.response?.status || 500).json({
            success: false,
            error: err.response?.data || err.message,
        });
    }
};

// NDR - ReAttempt
const ReAttempt = async (req, res) => {
    const payload = req.body;
    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    try {
        logger.info("ReAttempt: Request received", { payload });

        const { order_id, order_tracking_number, date_time } = payload;

        // Validate required fields
        if (!order_id || !order_tracking_number || !date_time) {
            logger.warn("ReAttempt: Missing required fields", { payload });
            return res.status(400).json({
                success: false,
                error: true,
                message: "order_id, order_tracking_number, and date_time are required",
            });
        }

        // Call Shipway ReAttempt API
        logger.info("ReAttempt: Calling Shipway API", { order_id, order_tracking_number, date_time });

        let response;
        try {
            response = await axios.post(
                process.env.SHIPWAY_ReAttempt_URL,
                payload,
                { headers }
            );
            logger.info("ReAttempt: Shipway API success", { order_id });
        } catch (apiErr) {
            logger.error("ReAttempt: Shipway API failed", {
                order_id,
                status: apiErr.response?.status,
                error: apiErr.response?.data || apiErr.message,
            });
            return res.status(apiErr.response?.status || 500).json({
                success: false,
                error: apiErr.response?.data || apiErr.message,
            });
        }

        // Return success response
        return res.status(200).json({
            success: true,
            data: response.data,
        });
    } catch (err) {
        logger.error("ReAttempt: Internal error", { error: err.message });
        return res.status(err.response?.status || 500).json({
            success: false,
            error: err.response?.data || err.message,
        });
    }
};

// NDR - RTO
const RTO = async (req, res) => {
    const payload = req.body;
    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    try {
        logger.info("RTO: Request received", { payload });

        const { order_id, order_tracking_number, date_time, reason } = payload;

        // Validate required fields
        if (!order_id || !order_tracking_number || !date_time || !reason) {
            logger.warn("RTO: Missing required fields", { payload });
            return res.status(400).json({
                success: false,
                error: true,
                message:
                    "order_id, order_tracking_number, date_time, and reason are required",
            });
        }

        // Call Shipway RTO API
        logger.info("RTO: Calling Shipway API", {
            order_id,
            order_tracking_number,
            date_time,
            reason,
        });

        let response;
        try {
            response = await axios.post(
                process.env.SHIPWAY_RTO_URL,
                payload,
                { headers }
            );
            logger.info("RTO: Shipway API success", { order_id });
        } catch (apiErr) {
            logger.error("RTO: Shipway API failed", {
                order_id,
                status: apiErr.response?.status,
                error: apiErr.response?.data || apiErr.message,
            });
            return res.status(apiErr.response?.status || 500).json({
                success: false,
                error: apiErr.response?.data || apiErr.message,
            });
        }

        // Return success response
        return res.status(200).json({
            success: true,
            data: response.data,
        });
    } catch (err) {
        logger.error("RTO: Internal error", { error: err.message });
        return res.status(err.response?.status || 500).json({
            success: false,
            error: err.response?.data || err.message,
        });
    }
};

// NDR - OrderDetails
const OrderDetails = async (req, res) => {
    const payload = req.body;
    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    try {
        logger.info("OrderDetails: Request received", { payload });

        const { order_id } = payload;

        // Validate required field
        if (!order_id) {
            logger.warn("OrderDetails: Missing required field", { payload });
            return res.status(400).json({
                success: false,
                error: true,
                message: "order_id is required",
            });
        }

        // Call Shipway API
        logger.info("OrderDetails: Calling Shipway API", { order_id });

        let response;
        try {
            response = await axios.post(
                process.env.SHIPWAY_OrderDetails_URL,
                payload,
                { headers }
            );
            logger.info("OrderDetails: Shipway API success", { order_id });
        } catch (apiErr) {
            logger.error("OrderDetails: Shipway API failed", {
                order_id,
                status: apiErr.response?.status,
                error: apiErr.response?.data || apiErr.message,
            });
            return res.status(apiErr.response?.status || 500).json({
                success: false,
                error: apiErr.response?.data || apiErr.message,
            });
        }

        // Return response
        return res.status(200).json({
            success: true,
            data: response.data,
        });
    } catch (err) {
        logger.error("OrderDetails: Internal error", { error: err.message });
        return res.status(err.response?.status || 500).json({
            success: false,
            error: err.response?.data || err.message,
        });
    }
};

// Carriers
const getcarrier = async (req, res) => {
    try {
        logger.info("getcarrier: Request received");

        const url = process.env.SHIPWAY_GETCARRIER_URL;

        let response;
        try {
            response = await axios.get(url, {
                headers: {
                    Authorization: `Basic ${token}`,
                    "Content-Type": "application/json",
                },
                timeout: 10000, // 10s timeout
            });
            logger.info("getcarrier: Shipway API success");
        } catch (apiErr) {
            logger.error("getcarrier: Shipway API failed", {
                status: apiErr.response?.status,
                error: apiErr.response?.data || apiErr.message,
            });
            return res.status(apiErr.response?.status || 500).json({
                success: false,
                error: apiErr.response?.data || apiErr.message,
            });
        }

        // Transform response
        const transformed = (response.data?.message || []).map(item => ({
            carrier_id: item.id,
            carrier_name: item.name.replace(/\s*\(.*?\)\s*/g, ""), // clean (0.5kg) etc.
            ...item,
        }));

        logger.info("getcarrier: Transformation completed", { count: transformed.length });

        return res.status(200).json({
            success: true,
            error: false,
            message: transformed,
        });
    } catch (err) {
        logger.error("getcarrier: Internal error", { error: err.message });
        return res.status(500).json({
            success: false,
            error: err.message || "Internal Server Error",
        });
    }
};

// Warehouse
const warehouse = async (req, res) => {
    const payload = req.body;
    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    logger.info("warehouse: Request received", { payload });

    // Validate required fields
    const requiredFields = [
        "title", "contact_person_name", "email", "phone",
        "address_1", "city", "state", "country", "pincode"
    ];
    for (const field of requiredFields) {
        if (!payload[field]) {
            logger.warn("warehouse: Validation failed", { field });
            return res.status(400).json({
                success: false,
                error: true,
                message: `${field} is required`,
            });
        }
    }

    let db;
    try {
        db = await connectToDatabase();
        logger.info("warehouse: Database connected");
    } catch (err) {
        logger.error("warehouse: Database connection failed", { error: err.message });
        return res.status(500).json({ success: false, error: true, message: "Database connection failed" });
    }

    // Prepare flat document data
    const warehouseDoc = {
        title: payload.title,
        company: payload.company || "",
        contact_person_name: payload.contact_person_name,
        email: payload.email,
        phone: payload.phone,
        phone_print: payload.phone_print || "",
        address_1: payload.address_1,
        address_2: payload.address_2 || "",
        city: payload.city,
        state: payload.state,
        country: payload.country,
        pincode: payload.pincode,
        longitude: payload.longitude || "",
        latitude: payload.latitude || "",
        gst_no: payload.gst_no || "",
        fssai_code: payload.fssai_code || "",
        created_at: new Date(),
        status_message: "Pending",
        warehouse_response: null,
    };

    let existingWarehouse;
    try {
        // Check if warehouse already exists
        existingWarehouse = await db.collection("warehouse").findOne({
            title: payload.title,
            contact_person_name: payload.contact_person_name,
            email: payload.email,
            phone: payload.phone,
            address_1: payload.address_1,
            city: payload.city,
            state: payload.state,
            country: payload.country,
            pincode: payload.pincode,
        });
        logger.info("warehouse: Existing warehouse check done", { found: !!existingWarehouse });
    } catch (err) {
        logger.error("warehouse: Database query failed", { error: err.message });
        return res.status(500).json({ success: false, error: true, message: "Database query failed" });
    }

    try {
        // Call Shipway Warehouse API
        const response = await axios.post(process.env.SHIPWAY_warehouse_URL, payload, { headers });
        logger.info("warehouse: Shipway API success", { response: response.data });

        const message = response.data?.data?.message || response.data?.message || "No message returned";
        const warehouseResponse = response.data?.data?.warehouse_response || response.data?.warehouse_response || {};

        if (existingWarehouse) {
            // Update existing document
            await db.collection("warehouse").updateOne(
                { _id: existingWarehouse._id },
                {
                    $set: {
                        status_message: message,
                        warehouse_response: warehouseResponse,
                        updated_at: new Date(),
                    },
                }
            );
        } else {
            // Insert new document
            await db.collection("warehouse").insertOne({
                ...warehouseDoc,
                status_message: message,
                warehouse_response: warehouseResponse,
            });
        }

        return res.status(message === "Warehouse Created Successfully" ? 200 : 400).json({
            success: message === "Warehouse Created Successfully",
            error: message !== "Warehouse Created Successfully",
            message,
            warehouse_response: warehouseResponse,
        });
    } catch (err) {
        //  Handle Shipway errors
        let errMessage = "";
        let warehouseResponse = {};
        if (err.response) {
            logger.error("warehouse: Shipway API error", {
                status: err.response.status,
                data: err.response.data,
            });
            errMessage =
                err.response.data?.data?.message ||
                err.response.data?.message ||
                JSON.stringify(err.response.data) ||
                "Unknown Shipway error";
            warehouseResponse = err.response.data?.data?.warehouse_response || {};
        } else {
            logger.error("warehouse: Request error", { error: err.message });
            errMessage = err.message || "Unknown request error";
        }

        if (existingWarehouse) {
            await db.collection("warehouse").updateOne(
                { _id: existingWarehouse._id },
                {
                    $set: {
                        status_message: errMessage,
                        warehouse_response: warehouseResponse,
                        updated_at: new Date(),
                    },
                }
            );
        }

        return res.status(err.response?.status || 500).json({
            success: false,
            error: true,
            message: errMessage,
            warehouse_response: warehouseResponse,
        });
    }
};

// Get Warehouses
const getwarehouses = async (req, res) => {
    logger.info("getwarehouses: Request received");

    try {
        const url = process.env.SHIPWAY_getwarehouses_URL;

        const response = await axios.get(url, {
            headers: {
                Authorization: `Basic ${token}`,
                "Content-Type": "application/json",
            },
            timeout: 10000,
        });

        logger.info("getwarehouses: Shipway API success", { count: response.data?.length || 0 });

        return res.status(200).json({
            success: true,
            error: false,
            data: response.data,
        });
    } catch (err) {
        if (err.response) {
            logger.error("getwarehouses: Shipway API error", {
                status: err.response.status,
                data: err.response.data,
            });
            return res.status(err.response.status).json({
                success: false,
                error: "Shipway API error",
                details: err.response.data || err.response.statusText,
            });
        }

        logger.error("getwarehouses: Request failed", { error: err.message });
        return res.status(500).json({
            success: false,
            error: true,
            message: err.message || "Internal Server Error",
        });
    }
};

// Pincode Serviceability
const pincodeserviceable = async (req, res) => {
    logger.info("pincodeserviceable: Request received", { query: req.query });

    try {
        const url = process.env.SHIPWAY_pincodeserviceable_URL;

        // Validate pincode
        const { pincode } = req.query;
        if (!pincode) {
            logger.warn("pincodeserviceable: Missing pincode in request");
            return res.status(400).json({
                success: false,
                error: true,
                message: "pincode is required",
            });
        }
        if (!/^\d+$/.test(pincode)) {
            logger.warn("pincodeserviceable: Invalid pincode format", { pincode });
            return res.status(400).json({
                success: false,
                error: true,
                message: "pincode must be a valid number",
            });
        }

        // Call Shipway API
        const response = await axios.get(`${url}?pincode=${pincode}`, {
            headers: {
                Authorization: `Basic ${token}`,
                "Content-Type": "application/json",
            },
            timeout: 10000,
        });

        logger.info("pincodeserviceable: Shipway API response received");

        // Validate Shipway response
        if (!Array.isArray(response.data.message)) {
            logger.warn("pincodeserviceable: Pincode not serviceable", { pincode });
            return res.status(400).json({
                success: false,
                error: true,
                message: `${pincode} pincode - our courier service is not available, please change your delivery address.`,
            });
        }

        // Filter only Prepaid (P)
        const filteredData = {
            ...response.data,
            message: response.data.message.filter(item => item.payment_type === "P"),
        };

        logger.info("pincodeserviceable: Returning filtered response", { count: filteredData.message.length });

        return res.status(200).json({
            success: true,
            error: false,
            data: filteredData,
        });

    } catch (err) {
        if (err.response) {
            logger.error("pincodeserviceable: Shipway API error", {
                status: err.response.status,
                data: err.response.data,
            });
            return res.status(err.response.status).json({
                success: false,
                error: "Shipway API error",
                details: err.response.data || err.response.statusText,
            });
        }

        logger.error("pincodeserviceable: Request failed", { error: err.message });
        return res.status(500).json({
            success: false,
            error: true,
            message: err.message || "Internal Server Error",
        });
    }
};

module.exports = {
    pushOrders, labelGeneration, CreateOrderManifest, OnholdOrders, CancelOrders, createPickup, getOrders, getAllOrders, 
    CancelShipment, InsertOrder, ReAttempt, RTO, OrderDetails, getcarrier, warehouse, getwarehouses, pincodeserviceable,
};
