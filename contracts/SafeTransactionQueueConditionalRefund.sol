// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity >=0.8.0 <0.9.0;

import "@gnosis.pm/safe-contracts/contracts/GnosisSafe.sol";
import "@gnosis.pm/safe-contracts/contracts/common/Enum.sol";
import "hardhat/console.sol";

/// ERRORS ///

/// @notice Thrown when the transaction reverts during the execution
error ExecutionFailure();

/// @notice Thrown when the refund receiver was not allowlisted
error InvalidRefundReceiver();

/// @notice Thrown when refund conditions for gas limit or gas price were not met
error RefundGasBoundariesNotMet();

/// @notice Thrown when failed to pay the refund
error RefundFailure();

/// @notice Thrown when the gas supplied to the transaction is less than signed gas limit
error NotEnoughGas();

/**
 * @title SafeTransactionQueueConditionalRefund
 * @author @mikhailxyz
 * @notice SafeTransactionQueueConditionalRefund is an alternative transaction queue for the Gnosis Safe using the modules feature.
 *         The built-in transaction queue of the Gnosis Safe does not work well for refunds in multi-sig scenarios.
 *         For example, the refund gas price is a part of the transaction that has to be signed by the owners.
 *         Since the gas price is volatile on some networks, if the network gas price is higher than the refund gas price
 *         at the time of the execution, the relayer doesn't have an economic motivation to pick up the transaction.
 *         The owners must either wait for the price to go down or regather transaction signatures with a higher gas price.
 *         This contract separates the transaction and refund params (Gas Price, Gas Limit, Refund Receiver, Gas Token).
 *         The refund params have to be signed only by 1 owner. To protect from unreasonably high gas prices, safe owners can set boundaries for each param.
 */
contract SafeTransactionQueueConditionalRefund is Enum {
    bytes32 private constant DOMAIN_SEPARATOR_TYPEHASH = keccak256("EIP712Domain(uint256 chainId,address verifyingContract)");

    bytes32 private constant SAFE_TX_TYPEHASH =
        keccak256("SafeTx(address safe,address to,uint256 value,bytes data,uint8 operation,uint256 nonce)");
    bytes32 private constant REFUND_PARAMS_TYPEHASH =
        keccak256("RefundParams(bytes32 safeTxHash,address gasToken,uint120 gasLimit,uint120 maxFeePerGas,address refundReceiver)");

    event SuccessfulExecution(bytes32 txHash, uint256 payment);

    struct RefundCondition {
        uint120 maxFeePerGas;
        uint120 maxGasLimit;
        uint16 allowedRefundReceiversCount;
        mapping(address => bool) refundReceiverAllowlist;
    }

    struct SafeTx {
        address payable safe;
        address to;
        uint256 value;
        bytes data;
        Enum.Operation operation;
    }

    struct RefundParams {
        address gasToken;
        uint120 gasLimit;
        uint120 maxFeePerGas;
        address payable refundReceiver;
    }

    mapping(address => uint256) public safeNonces;
    // safeAddress -> tokenAddress -> RefundCondition
    mapping(address => mapping(address => RefundCondition)) public safeRefundConditions;

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, block.chainid, this));
    }

    /// @dev Sets the maximum boundary for the given safe and gas token. For legacy networks that don't support EIP1559 set both to equal amounts
    /// @param tokenAddress Refund token address
    /// @param maxFeePerGas Maximum fee
    /// @param maxGasLimit Maximum gas limit that can be refunded, includes base gas (gas independent of the transaction execution)
    /// @param refundReceiverAllowlist Addresses of allowed refund receivers
    function setRefundConditions(
        address tokenAddress,
        uint120 maxFeePerGas,
        uint120 maxGasLimit,
        address[] calldata refundReceiverAllowlist
    ) public {
        RefundCondition storage refundCondition = safeRefundConditions[msg.sender][tokenAddress];
        refundCondition.maxFeePerGas = maxFeePerGas;
        refundCondition.maxGasLimit = maxGasLimit;
        refundCondition.allowedRefundReceiversCount = uint16(refundReceiverAllowlist.length);

        unchecked {
            for (uint16 i = 0; i < refundCondition.allowedRefundReceiversCount; i++)
                refundCondition.refundReceiverAllowlist[refundReceiverAllowlist[i]] = true;
        }
    }

    /// @dev Executes a transaction from the Safe if it has the required amount of signatures. No Refund logic is performed.
    /// Mention that guards are not taken into account.
    /// @param safeTx Safe Transaction
    /// @param signatures Packed signature data ({bytes32 r}{bytes32 s}{uint8 v})
    /// @return success True if the transaction succeeded
    function execTransaction(SafeTx calldata safeTx, bytes memory signatures) external payable returns (bool success) {
        bytes32 safeTxHash;
        {
            uint256 nonce = safeNonces[safeTx.safe];
            bytes memory encodedTransactionData = encodeTransactionData(
                safeTx.safe,
                safeTx.to,
                safeTx.value,
                safeTx.data,
                safeTx.operation,
                nonce
            );
            safeNonces[safeTx.safe] = nonce + 1;
            safeTxHash = keccak256(encodedTransactionData);
            GnosisSafe(safeTx.safe).checkSignatures(safeTxHash, encodedTransactionData, signatures);
        }

        {
            success = execute(safeTx.safe, safeTx.to, safeTx.value, safeTx.data, safeTx.operation);
            if (!success) {
                revert ExecutionFailure();
            }
            emit SuccessfulExecution(safeTxHash, 0);
        }
    }

    function execTransactionWithRefund(
        // Transaction params
        SafeTx calldata safeTx,
        bytes memory txSignatures,
        // Refund params
        RefundParams calldata refundParams,
        bytes memory refundSignature
    ) external payable {
        // initial gas = 21k + non_zero_bytes * 16 + zero_bytes * 4
        //            ~= 21k + calldata.length * [1/3 * 16 + 2/3 * 4]
        uint256 startGas = gasleft() + 21000 + msg.data.length * 8;
        if (startGas < refundParams.gasLimit) {
            revert NotEnoughGas();
        }

        // Transaction checks
        bytes32 safeTxHash;
        {
            uint256 nonce = safeNonces[safeTx.safe];
            bytes memory encodedTransactionData = encodeTransactionData(
                safeTx.safe,
                safeTx.to,
                safeTx.value,
                safeTx.data,
                safeTx.operation,
                nonce
            );
            safeNonces[safeTx.safe] = nonce + 1;
            safeTxHash = keccak256(encodedTransactionData);
            GnosisSafe(safeTx.safe).checkSignatures(safeTxHash, encodedTransactionData, txSignatures);
        }

        // Refund params checks
        {
            bytes memory encodedRefundParamsData = encodeRefundParamsData(
                safeTxHash,
                refundParams.gasToken,
                refundParams.gasLimit,
                refundParams.maxFeePerGas,
                refundParams.refundReceiver
            );
            bytes32 refundParamsHash = keccak256(encodedRefundParamsData);
            GnosisSafe(safeTx.safe).checkNSignatures(refundParamsHash, encodedRefundParamsData, refundSignature, 1);
        }

        RefundCondition storage refundCondition = safeRefundConditions[safeTx.safe][refundParams.gasToken];
        // If an allowlist is enforced, check if the refundReceiver is allowed and doesnt equal to zero address
        if (
            refundCondition.allowedRefundReceiversCount != 0 &&
            (refundCondition.refundReceiverAllowlist[refundParams.refundReceiver] == false)
        ) {
            revert InvalidRefundReceiver();
        }

        // Gas price and limit check
        if (refundParams.maxFeePerGas > refundCondition.maxFeePerGas || refundParams.gasLimit > refundCondition.maxGasLimit) {
            revert RefundGasBoundariesNotMet();
        }

        {
            execute(safeTx.safe, safeTx.to, safeTx.value, safeTx.data, safeTx.operation);

            uint256 payment = handleRefund(
                safeTx.safe,
                startGas,
                refundParams.gasLimit,
                refundParams.maxFeePerGas,
                refundParams.gasToken,
                refundParams.refundReceiver
            );
            emit SuccessfulExecution(safeTxHash, payment);
        }
    }

    function handleRefund(
        address safe,
        uint256 startGas,
        uint120 gasLimit,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver
    ) private returns (uint256 payment) {
        // solhint-disable-next-line avoid-tx-origin
        address payable receiver = refundReceiver == address(0) ? payable(tx.origin) : refundReceiver;
        // 23k as an upper bound to cover the rest of refund logic
        uint256 gasConsumed = startGas - gasleft() + 23000;
        payment = min(gasConsumed, gasLimit) * gasPrice;

        if (gasToken == address(0)) {
            if (!execute(safe, receiver, payment, "0x", Operation.Call)) {
                revert RefundFailure();
            }
        } else {
            // 0xa9059cbb - keccack("transfer(address,uint256)")
            bytes memory data = abi.encodeWithSelector(0xa9059cbb, receiver, payment);
            if (!execute(safe, gasToken, 0, data, Operation.Call)) {
                revert RefundFailure();
            }
        }
    }

    /// @dev Returns transaction bytes to be signed by owners.
    /// @param safe Safe address
    /// @param to Safe address
    /// @param value Native token value of the transaction
    /// @param data Call data
    /// @param operation Operation type of the transaction (CALL, DELEGATECALL)
    /// @param nonce Transaction nonce
    /// @return Transaction bytes
    function encodeTransactionData(
        address safe,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 nonce
    ) public view returns (bytes memory) {
        bytes32 safeTransactionHash = keccak256(abi.encode(SAFE_TX_TYPEHASH, safe, to, value, keccak256(data), operation, nonce));

        return abi.encodePacked(bytes1(0x19), bytes1(0x01), domainSeparator(), safeTransactionHash);
    }

    /// @dev Returns the transaction hash to be signed by owners.
    /// @param safe Safe address
    /// @param to Safe address
    /// @param value Native token value of the transaction
    /// @param data Call data
    /// @param operation Operation type of the transaction (CALL, DELEGATECALL)
    /// @param nonce Transaction nonce
    /// @return Transaction hash
    function getTransactionHash(
        address safe,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 nonce
    ) public view returns (bytes32) {
        return keccak256(encodeTransactionData(safe, to, value, data, operation, nonce));
    }

    /// @dev Returns the refund params bytes to be signed by owners.
    /// @param safeTxHash Safe transaction hash
    /// @param gasToken Gas Token address
    /// @param maxFeePerGas Maximum fee
    /// @param refundReceiver Refund recipient address
    /// @return Refund params bytes
    function encodeRefundParamsData(
        bytes32 safeTxHash,
        address gasToken,
        uint120 gasLimit,
        uint120 maxFeePerGas,
        address refundReceiver
    ) public view returns (bytes memory) {
        bytes32 safeOperationHash = keccak256(
            abi.encode(REFUND_PARAMS_TYPEHASH, safeTxHash, gasToken, gasLimit, maxFeePerGas, refundReceiver)
        );

        return abi.encodePacked(bytes1(0x19), bytes1(0x01), domainSeparator(), safeOperationHash);
    }

    /// @dev Returns the refund params hash to be signed by owners.
    /// @param safeTxHash Safe transaction hash
    /// @param gasToken Gas Token address
    /// @param gasLimit Transaction gas limit
    /// @param maxFeePerGas Maximum fee
    /// @param refundReceiver Refund recipient address
    /// @return Refund params hash
    function getRefundParamsHash(
        bytes32 safeTxHash,
        address gasToken,
        uint120 gasLimit,
        uint120 maxFeePerGas,
        address refundReceiver
    ) public view returns (bytes32) {
        return keccak256(encodeRefundParamsData(safeTxHash, gasToken, gasLimit, maxFeePerGas, refundReceiver));
    }

    /// @dev Internal function to execute a transaction from the Safe
    /// @param safe Safe address
    /// @param to Destination address of transaction
    /// @param value Native token value of transaction
    /// @param data Data payload of transaction
    /// @param operation Operation type of transaction: Call or DelegateCall
    /// @return success Boolean indicating success of the transaction
    function execute(
        address safe,
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation
    ) internal returns (bool success) {
        success = GnosisSafe(payable(safe)).execTransactionFromModule(to, value, data, operation);
    }

    /**
     * @dev A function to check if a given address is a valid refund receiver for a given Safe and token
     * @param safe Safe address
     * @param gasToken Gas Token address
     * @param refundReceiver Refund receiver address
     * @return Boolean indicating if the address is a valid refund receiver
     */
    function isAllowedRefundReceiver(
        address safe,
        address gasToken,
        address refundReceiver
    ) public view returns (bool) {
        return
            safeRefundConditions[safe][gasToken].allowedRefundReceiversCount == 0 ||
            safeRefundConditions[safe][gasToken].refundReceiverAllowlist[refundReceiver];
    }

    /**
     * @dev Returns the smallest of two numbers.
     */
    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a >= b ? b : a;
    }
}
