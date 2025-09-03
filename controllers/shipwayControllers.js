const { connectToDatabase } = require('../config/db');
require('dotenv').config();
const axios = require('axios');

// -------------------------------------------------------------
const SHIPWAY_USERNAME = process.env.SHIPWAY_USERNAME;
const SHIPWAY_PASSWORD = process.env.SHIPWAY_PASSWORD;

// Encode username:password into Base64
const token = Buffer.from(`${SHIPWAY_USERNAME}:${SHIPWAY_PASSWORD}`).toString("base64");

// NDR
const SHIPWAY_InsertOrder_URL = process.env.SHIPWAY_InsertOrder_URL;
const SHIPWAY_ReAttempt_URL = process.env.SHIPWAY_ReAttempt_URL;
const SHIPWAY_RTO_URL = process.env.SHIPWAY_RTO_URL;
const SHIPWAY_OrderDetails_URL = process.env.SHIPWAY_OrderDetails_URL;

// Shipment Booking
const pushOrders = async (req, res) => {
    const payload = req.body; // order data from request body
    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    let db;
    try {
        db = await connectToDatabase();
    } catch (err) {
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

            // Only skip if NOT cancelled / onhold / cancelled shipment
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

        // Respond to client
        return res.status(200).json({
            success: true,
            message: statusMessage,
            data: response.data,
        });
    } catch (err) {
        // Handle Shipway errors
        if (err.response) {
            console.error("Shipway Error:", err.response.status, err.response.data);
            return res.status(err.response.status).json({
                success: false,
                error: err.response.data,
            });
        } else {
            console.error("Request Error:", err.message);
            return res.status(500).json({
                success: false,
                error: err.message,
            });
        }
    }
};

const labelGeneration = async (req, res) => {
    const payload = req.body;
    const headers = {
        Authorization: `Basic ${token}`,
        'Content-Type': 'application/json',
    };

    let db;
    try {
        db = await connectToDatabase();
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: true,
            message: 'Database connection failed',
        });
    }

    try {
        // Find existing order
        const existingOrder = await db.collection('pushorder').findOne({ order_id: payload.order_id });

        if (!existingOrder) {
            return res.status(404).json({
                success: false,
                error: true,
                message: `Order ID "${payload.order_id}" not found in pushorder collection.`,
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

        // If missing carrier/warehouse info → update them
        if (
            !existingOrder.carrier_id ||
            !existingOrder.warehouse_id ||
            !existingOrder.return_warehouse_id
        ) {
            await db.collection('pushorder').updateOne(
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
        const statusMessage = response.data?.message || 'Label generated successfully.';

        // Save AWB response to DB
        await db.collection('pushorder').updateOne(
            { order_id: payload.order_id },
            {
                $set: {
                    status_message: statusMessage,
                    awb_response: awbResponse,
                    updated_at: new Date(),
                },
            }
        );

        // Return response
        return res.status(200).json({
            success: true,
            message: statusMessage,
            awb_response: awbResponse,
        });

    } catch (err) {
        if (err.response) {
            console.error('Shipway Error:', err.response.status, err.response.data);
            return res.status(err.response.status).json({
                success: false,
                error: err.response.data,
            });
        } else {
            console.error('Request Error:', err.message);
            return res.status(500).json({
                success: false,
                error: err.message,
            });
        }
    }
};

const CreateOrderManifest = async (req, res) => {
    const payload = req.body;
    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    let db;
    try {
        db = await connectToDatabase();
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: true,
            message: "Database connection failed",
        });
    }

    try {
        const orderIds = payload.order_ids;
        if (!Array.isArray(orderIds) || orderIds.length === 0) {
            return res.status(400).json({
                success: false,
                error: true,
                message: "order_ids must be a non-empty array",
            });
        }

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
            const response = await axios.post(
                process.env.SHIPWAY_CreateOrderManifest_URL,
                { order_ids: newOrderIds },
                { headers }
            );

            manifestResponse = response.data || null;
            statusMessage = manifestResponse?.message || "Manifest request completed.";

            // Always save response, even if error
            await db.collection("pushorder").updateMany(
                { order_id: { $in: newOrderIds } },
                {
                    $set: {
                        manifest_response: manifestResponse, // full response (success or error)
                        manifest_status_message: statusMessage,
                        updated_at: new Date(),
                    },
                }
            );
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
        if (err.response) {
            console.error("Shipway Error:", err.response.status, err.response.data);

            // Even save the error response
            await db.collection("pushorder").updateMany(
                { order_id: { $in: req.body.order_ids } },
                {
                    $set: {
                        manifest_response: err.response.data,
                        manifest_status_message: "Manifest API failed",
                        updated_at: new Date(),
                    },
                }
            );

            return res.status(err.response.status).json({
                success: false,
                error: err.response.data,
            });
        } else {
            console.error("Request Error:", err.message);
            return res.status(500).json({
                success: false,
                error: err.message,
            });
        }
    }
};

const createPickup = async (req, res) => {
    const { order_ids, ...restPayload } = req.body;
    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    let db;
    try {
        db = await connectToDatabase();
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: true,
            message: "Database connection failed",
        });
    }

    if (!Array.isArray(order_ids) || order_ids.length === 0) {
        return res.status(400).json({
            success: false,
            error: true,
            message: "order_ids must be a non-empty array",
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
            const singlePayload = { ...restPayload, order_ids: [orderId] };
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

            results.push({
                order_id: orderId,
                success: true,
                message: statusMessage,
                response: pickupResponse,
            });
        } catch (err) {
            // Handle errors individually for each order
            if (err.response) {
                console.error(`Shipway Error for ${orderId}:`, err.response.status, err.response.data);
                await db.collection("pushorder").updateOne(
                    { order_id: orderId },
                    {
                        $set: {
                            createPickupData: { ...restPayload, order_ids: [orderId] },
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
                console.error(`Request Error for ${orderId}:`, err.message);
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

const OnholdOrders = async (req, res) => {
    const payload = req.body;
    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    let db;
    try {
        db = await connectToDatabase();
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: true,
            message: "Database connection failed",
        });
    }

    try {
        const orderIds = payload.order_ids || [];
        const finalResponses = [];

        for (const orderId of orderIds) {
            const existingOrder = await db.collection("pushorder").findOne({ order_id: orderId });

            // 🚨 Not found
            if (!existingOrder) {
                finalResponses.push({
                    order_id: orderId,
                    error: true,
                    success: false,
                    message: "Order not found in database",
                });
                continue;
            }

            // 🚨 Already Onhold
            if (existingOrder.onhold_response && existingOrder.onhold_response.success === true) {
                finalResponses.push({
                    order_id: orderId,
                    error: true,
                    success: false,
                    message: "This order is already Onhold",
                    onhold_response: existingOrder.onhold_response,
                });
                continue;
            }

            // ✅ Call Shipway
            let orderRes;
            try {
                const response = await axios.post(
                    process.env.SHIPWAY_OnholdOrders_URL,
                    { order_ids: [orderId] },
                    { headers }
                );

                orderRes = Array.isArray(response.data) ? response.data[0] : response.data;
            } catch (shipErr) {
                orderRes = {
                    order_id: orderId,
                    error: true,
                    success: false,
                    message: shipErr.response?.data?.message || "Shipway onhold failed",
                };
            }

            // ✅ Update DB
            await db.collection("pushorder").updateOne(
                { order_id: orderId },
                {
                    $set: {
                        status_message: orderRes.message || "Onhold status updated",
                        onhold_response: orderRes,
                        updated_at: new Date(),
                    },
                }
            );

            finalResponses.push({
                order_id: orderId,
                status_message: orderRes.message,
                onhold_response: orderRes,
                updated_at: new Date(),
            });
        }

        // 🚨 If all orders were already Onhold
        const allOnhold = finalResponses.every(
            (res) => res.error && res.message === "This order is already Onhold"
        );

        if (allOnhold) {
            return res.status(400).json({
                success: false,
                error: true,
                message: "All provided orders are already Onhold",
                data: finalResponses,
            });
        }

        return res.status(200).json({ success: true, data: finalResponses });
    } catch (err) {
        return res.status(err.response?.status || 500).json({
            success: false,
            error: err.response?.data || err.message,
        });
    }
};

const CancelOrders = async (req, res) => {
    const payload = req.body;
    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    let db;
    try {
        db = await connectToDatabase();
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: true,
            message: "Database connection failed",
        });
    }

    try {
        const orderIds = payload.order_ids || [];
        const finalResponses = [];

        for (const orderId of orderIds) {
            const existingOrder = await db.collection("pushorder").findOne({ order_id: orderId });

            if (!existingOrder) {
                finalResponses.push({
                    order_id: orderId,
                    error: true,
                    success: false,
                    message: "Order not found in database",
                });
                continue;
            }

            // Already cancelled
            if (existingOrder.cancel_response && existingOrder.cancel_response.success === true) {
                finalResponses.push({
                    order_id: orderId,
                    error: true,
                    success: false,
                    message: "This order is already Cancelled",
                    cancel_response: existingOrder.cancel_response,
                });
                continue; // skip Shipway call
            }

            // Call Shipway for this order
            let cancelRes;
            try {
                const response = await axios.post(
                    process.env.SHIPWAY_Cancelorders_URL,
                    { order_ids: [orderId] },
                    { headers }
                );

                cancelRes = Array.isArray(response.data) ? response.data[0] : response.data;
            } catch (shipErr) {
                cancelRes = {
                    order_id: orderId,
                    error: true,
                    success: false,
                    message: shipErr.response?.data?.message || "Shipway cancel failed",
                };
            }

            // Update DB
            await db.collection("pushorder").updateOne(
                { order_id: orderId },
                {
                    $set: {
                        status_message: cancelRes.message || "Cancel status updated",
                        cancel_response: cancelRes,
                        updated_at: new Date(),
                    },
                }
            );

            finalResponses.push({
                order_id: orderId,
                status_message: cancelRes.message,
                cancel_response: cancelRes,
                updated_at: new Date(),
            });
        }

        return res.status(200).json({
            success: true,
            data: finalResponses,
        });
    } catch (err) {
        return res.status(err.response?.status || 500).json({
            success: false,
            error: err.response?.data || err.message,
        });
    }
};

const CancelShipment = async (req, res) => {
    const payload = req.body; // Expecting { awb_number: ["1333110020164"] }
    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    let db;
    try {
        db = await connectToDatabase();
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: true,
            message: "Database connection failed",
        });
    }

    try {
        const awbNumbers = payload.awb_number;
        if (!Array.isArray(awbNumbers) || awbNumbers.length === 0) {
            return res.status(400).json({
                success: false,
                error: true,
                message: "awb_number array is required",
            });
        }

        const results = [];

        for (const awb of awbNumbers) {
            // Find order by AWB number
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

            // If already cancelled
            if (existingOrder.CancelShipment_response) {
                results.push({
                    awb_number: awb,
                    success: false,
                    error: true,
                    message: "This AWB is already cancelled",
                    CancelShipment_response: existingOrder.CancelShipment_response,
                });
                continue;
            }

            // Call Shipway CancelShipment API
            const response = await axios.post(
                process.env.SHIPWAY_CancelShipment_URL,
                { awb_number: [awb] },
                { headers }
            );

            const cancelRes = response.data;

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

            results.push({
                awb_number: awb,
                success: true,
                message: "Cancel shipment processed",
                CancelShipment_response: cancelRes,
            });
        }

        return res.status(200).json({
            success: true,
            data: results,
        });
    } catch (err) {
        if (err.response) {
            return res.status(err.response.status).json({
                success: false,
                error: err.response.data,
            });
        } else {
            return res.status(500).json({
                success: false,
                error: err.message,
            });
        }
    }
};

const getOrders = async (req, res) => {
    try {
        const url = process.env.SHIPWAY_GETORDERS_URL;
        const response = await axios.get(url, {
            headers: {
                Authorization: `Basic ${token}`,
                'Content-Type': 'application/json',
            },
        });

        return res.status(200).json(response.data);
    } catch (err) {
        if (err.response) {
            return res.status(err.response.status).json({
                success: 0,
                error: 'Shipway API error',
                details: err.response.data || err.response.statusText,
            });
        }
        return res.status(500).json({
            success: false,
            error: err.message || 'Internal Server Error',
        });
    }
};

const getAllOrders = async (req, res) => {
    let db;
    try {
        db = await connectToDatabase();
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: true,
            message: "Database connection failed",
        });
    }

    try {
        const orders = await db.collection("pushorder").find().toArray();

        if (!orders || orders.length === 0) {
            return res.status(200).json({
                success: false,
                error: true,
                message: "empty data",
                total_count: 0
            });
        }

        return res.status(200).json({
            success: true,
            error: false,
            total_count: orders.length,
            data: orders,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: true,
            message: err.message || "Internal Server Error",
            total_count: 0
        });
    }
};

// NDR
const InsertOrder = async (req, res) => {
    const payload = req.body;
    const headers = {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
    };

    let db;
    try {
        db = await connectToDatabase();
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: true,
            message: "Database connection failed",
        });
    }

    try {
        const { order_id, order_tracking_number } = payload;

        if (!order_id || !order_tracking_number) {
            return res.status(400).json({
                success: false,
                error: true,
                message: "order_id and order_tracking_number are required",
            });
        }

        // Find latest order with this order_id
        const existingOrder = await db.collection("pushorder").findOne(
            { order_id },
            { sort: { created_at: -1 } } // latest record
        );

        if (!existingOrder) {
            return res.status(404).json({
                success: false,
                error: true,
                message: `Order ID "${order_id}" not found in database`,
            });
        }

        // Already Onhold
        if (existingOrder.onhold_response?.success === true) {
            return res.status(400).json({
                success: false,
                error: true,
                message: "This order is already Onhold",
                onhold_response: existingOrder.onhold_response,
            });
        }

        // Already Cancelled
        if (existingOrder.cancel_response?.success === true) {
            return res.status(400).json({
                success: false,
                error: true,
                message: "This order is already Cancelled",
                cancel_response: existingOrder.cancel_response,
            });
        }

        // Already Cancelled Shipment
        if (existingOrder.cancel_shipment_response?.success === true) {
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
            return res.status(400).json({
                success: false,
                error: true,
                message: "not found or invalid order_tracking_number",
            });
        }

        // Call Shipway InsertOrder API
        const response = await axios.post(
            process.env.SHIPWAY_InsertOrder_URL,
            payload,
            { headers }
        );

        const insertRes = response.data;

        // Save InsertOrder response in the latest order
        await db.collection("pushorder").updateOne(
            { _id: existingOrder._id },
            {
                $set: {
                    insertorder_response: insertRes,
                    updated_at: new Date(),
                },
            }
        );

        return res.status(200).json({
            success: true,
            data: insertRes,
        });
    } catch (err) {
        return res.status(err.response?.status || 500).json({
            success: false,
            error: err.response?.data || err.message,
        });
    }
};

const ReAttempt = async (req, res) => {
    const payload = req.body; // take order data from request body
    const headers = {
        Authorization: `Basic ${token}`,
        'Content-Type': 'application/json',
    };

    console.log('POSTing to:', SHIPWAY_ReAttempt_URL);
    console.log('Headers:', headers);
    console.log('Payload:', JSON.stringify(payload, null, 2));

    try {
        const response = await axios.post(SHIPWAY_ReAttempt_URL, payload, { headers });

        return res.status(200).json({
            success: true,
            data: response.data,
        });
    } catch (err) {
        if (err.response) {
            console.error('Shipway Error:', err.response.status, err.response.data);
            return res.status(err.response.status).json({
                success: false,
                error: err.response.data,
            });
        } else {
            console.error('Request Error:', err.message);
            return res.status(500).json({
                success: false,
                error: err.message,
            });
        }
    }
};

const RTO = async (req, res) => {
    const payload = req.body; // take order data from request body
    const headers = {
        Authorization: `Basic ${token}`,
        'Content-Type': 'application/json',
    };

    console.log('POSTing to:', SHIPWAY_RTO_URL);
    console.log('Headers:', headers);
    console.log('Payload:', JSON.stringify(payload, null, 2));

    try {
        const response = await axios.post(SHIPWAY_RTO_URL, payload, { headers });

        return res.status(200).json({
            success: true,
            data: response.data,
        });
    } catch (err) {
        if (err.response) {
            console.error('Shipway Error:', err.response.status, err.response.data);
            return res.status(err.response.status).json({
                success: false,
                error: err.response.data,
            });
        } else {
            console.error('Request Error:', err.message);
            return res.status(500).json({
                success: false,
                error: err.message,
            });
        }
    }
};

const OrderDetails = async (req, res) => {
    const payload = req.body; // take order data from request body
    const headers = {
        Authorization: `Basic ${token}`,
        'Content-Type': 'application/json',
    };

    console.log('POSTing to:', SHIPWAY_OrderDetails_URL);
    console.log('Headers:', headers);
    console.log('Payload:', JSON.stringify(payload, null, 2));

    try {
        const response = await axios.post(SHIPWAY_OrderDetails_URL, payload, { headers });

        return res.status(200).json({
            success: true,
            data: response.data,
        });
    } catch (err) {
        if (err.response) {
            console.error('Shipway Error:', err.response.status, err.response.data);
            return res.status(err.response.status).json({
                success: false,
                error: err.response.data,
            });
        } else {
            console.error('Request Error:', err.message);
            return res.status(500).json({
                success: false,
                error: err.message,
            });
        }
    }
};

// Carriers
const getcarrier = async (req, res) => {
    try {
        const url = process.env.SHIPWAY_GETCARRIER_URL;

        const response = await axios.get(url, {
            headers: {
                Authorization: `Basic ${token}`,
                'Content-Type': 'application/json',
            },
            timeout: 10000,
        });

        // ✅ Transform response: add carrier_id & clean carrier_name
        const transformed = response.data.message.map(item => {
            return {
                carrier_id: item.id,
                carrier_name: item.name.replace(/\s*\(.*?\)\s*/g, ""), // remove (0.5kg) or (10kg)
                ...item
            };
        });

        return res.status(200).json({
            success: 1,
            error: "",
            message: transformed
        });

    } catch (err) {
        if (err.response) {
            return res.status(err.response.status).json({
                success: 0,
                error: 'Shipway API error',
                details: err.response.data || err.response.statusText,
            });
        }
        return res.status(500).json({
            success: false,
            error: err.message || 'Internal Server Error',
        });
    }
};

// Warehouse
const warehouse = async (req, res) => {
    const payload = req.body;
    const headers = {
        Authorization: `Basic ${token}`,
        'Content-Type': 'application/json',
    };

    let db;
    try {
        db = await connectToDatabase();
    } catch (err) {
        return res.status(500).json({ success: false, error: true, message: 'Database connection failed' });
    }

    // 1️⃣ Prepare flat document data
    const warehouseDoc = {
        title: payload.title,
        company: payload.company,
        contact_person_name: payload.contact_person_name,
        email: payload.email,
        phone: payload.phone,
        phone_print: payload.phone_print || '',
        address_1: payload.address_1,
        address_2: payload.address_2,
        city: payload.city,
        state: payload.state,
        country: payload.country,
        pincode: payload.pincode,
        longitude: payload.longitude,
        latitude: payload.latitude,
        gst_no: payload.gst_no,
        fssai_code: payload.fssai_code,
        created_at: new Date(),
        status_message: 'Pending',
        warehouse_response: null
    };

    let existingWarehouse;
    try {
        // 2️⃣ Check if warehouse with same details exists
        existingWarehouse = await db.collection('warehouse').findOne({
            title: payload.title,
            company: payload.company,
            contact_person_name: payload.contact_person_name,
            email: payload.email,
            phone: payload.phone,
            address_1: payload.address_1,
            address_2: payload.address_2,
            city: payload.city,
            state: payload.state,
            country: payload.country,
            pincode: payload.pincode
        });
    } catch (err) {
        console.error('MongoDB query error:', err);
        return res.status(500).json({ success: false, error: true, message: 'Database query failed' });
    }

    let warehouseId;

    try {
        // 3️⃣ Send request to Shipway
        const response = await axios.post(process.env.SHIPWAY_warehouse_URL, payload, { headers });

        const message = response.data?.data?.message || response.data?.message || 'No message returned';
        const warehouseResponse = response.data?.data?.warehouse_response || response.data?.warehouse_response || {};

        if (existingWarehouse) {
            // 4️⃣ Update existing document
            await db.collection('warehouse').updateOne(
                { _id: existingWarehouse._id },
                {
                    $set: {
                        status_message: message,
                        warehouse_response: warehouseResponse,
                        updated_at: new Date()
                    }
                }
            );
            warehouseId = existingWarehouse._id;
        } else {
            // 4️⃣ Insert new document
            const insertedDoc = await db.collection('warehouse').insertOne({
                ...warehouseDoc,
                status_message: message,
                warehouse_response: warehouseResponse
            });
            warehouseId = insertedDoc.insertedId;
        }

        // 5️⃣ Send response
        return res.status(message === "Warehouse Created Successfully" ? 200 : 400).json({
            success: message === "Warehouse Created Successfully",
            error: message !== "Warehouse Created Successfully",
            message,
            warehouse_response: warehouseResponse,
        });

    } catch (err) {
        let errMessage = '';
        let warehouseResponse = {};
        if (err.response) {
            console.error('Shipway Error:', err.response.status, err.response.data);
            errMessage = err.response.data?.data?.message || err.response.data?.message || JSON.stringify(err.response.data) || 'Unknown error';
            warehouseResponse = err.response.data?.data?.warehouse_response || {};
        } else {
            console.error('Request Error:', err.message);
            errMessage = err.message || 'Unknown request error';
        }

        // Update status_message if document exists
        if (existingWarehouse) {
            await db.collection('warehouse').updateOne(
                { _id: existingWarehouse._id },
                {
                    $set: {
                        status_message: errMessage,
                        warehouse_response: warehouseResponse,
                        updated_at: new Date()
                    }
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

const getwarehouses = async (req, res) => {
    try {
        const url = process.env.SHIPWAY_getwarehouses_URL;

        const response = await axios.get(url, {
            headers: {
                Authorization: `Basic ${token}`,
                'Content-Type': 'application/json',
            },
            timeout: 10000,
        });

        return res.status(200).json(response.data);
    } catch (err) {
        if (err.response) {
            return res.status(err.response.status).json({
                success: 0,
                error: 'Shipway API error',
                details: err.response.data || err.response.statusText,
            });
        }
        return res.status(500).json({
            success: false,
            error: err.message || 'Internal Server Error',
        });
    }
};

// Pincode Serviceable
// const pincodeserviceable = async (req, res) => {
//     try {
//         const url = process.env.SHIPWAY_pincodeserviceable_URL;

//         // Read pincode from query
//         const { pincode } = req.query;
//         if (!pincode) {
//             return res.status(400).json({ success: false, error: "Pincode is required" });
//         }

//         const response = await axios.get(`${url}?pincode=${pincode}`, {
//             headers: {
//                 Authorization: `Basic ${token}`,
//                 'Content-Type': 'application/json',
//             },
//             timeout: 10000,
//         });

//         return res.status(200).json(response.data);
//     } catch (err) {
//         if (err.response) {
//             return res.status(err.response.status).json({
//                 success: 0,
//                 error: 'Shipway API error',
//                 details: err.response.data || err.response.statusText,
//             });
//         }
//         return res.status(500).json({
//             success: false,
//             error: err.message || 'Internal Server Error',
//         });
//     }
// };

const pincodeserviceable = async (req, res) => {
    try {
        const url = process.env.SHIPWAY_pincodeserviceable_URL;

        // Read pincode from query
        const { pincode } = req.query;
        if (!pincode) {
            return res.status(400).json({ success: false, error: "Pincode is required" });
        }

        const response = await axios.get(`${url}?pincode=${pincode}`, {
            headers: {
                Authorization: `Basic ${token}`,
                'Content-Type': 'application/json',
            },
            timeout: 10000,
        });

        // Filter only payment_type = "P"
        const filteredData = {
            ...response.data,
            message: response.data.message?.filter(item => item.payment_type === "P") || []
        };

        return res.status(200).json(filteredData);
    } catch (err) {
        if (err.response) {
            return res.status(err.response.status).json({
                success: 0,
                error: 'Shipway API error',
                details: err.response.data || err.response.statusText,
            });
        }
        return res.status(500).json({
            success: false,
            error: err.message || 'Internal Server Error',
        });
    }
};

module.exports = {
    pushOrders, labelGeneration, getOrders, getAllOrders, CreateOrderManifest, OnholdOrders, CancelOrders, createPickup, CancelShipment,
    InsertOrder, ReAttempt, RTO, OrderDetails, getcarrier, warehouse, getwarehouses, pincodeserviceable,
};
