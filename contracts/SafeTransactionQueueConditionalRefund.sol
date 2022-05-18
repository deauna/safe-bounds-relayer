// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity >=0.8.0 <0.9.0;

import "@gnosis.pm/safe-contracts/contracts/GnosisSafe.sol";
import "@gnosis.pm/safe-contracts/contracts/common/Enum.sol";
import "hardhat/console.sol";

/// ERRORS ///

/// @notice Thrown when the provided transaction signatures we invalid
error InvalidTransactionSignatures();

/// @notice Thrown when the provided relay signature is invalid
error InvalidRelaySignature();

/// @notice Thrown when the transaction reverts during the execution
error ExecutionFailure();

/// @notice Thrown when the refund receiver was not allowlisted
error InvalidRefundReceiver();

/// @notice Thrown when relaying conditions were not met
error RelayGasPriceConditionsNotMet();

/// @notice Thrown when failed to pay the refund
error RefundFailure();

/// @notice Thrown when the gas supplied by the relayer is less than signed gas limit
error NotEnoughGas();

/// @title SafeBoundsRelayer
/// @author Mikhail Mikheev - <mikhail@gnosis.io>
/// @notice Gnosis Safe module for relaying transactions with an upper bound in the gas price
contract SafeTransactionQueueConditionalRefund is Enum {
    bytes32 private constant DOMAIN_SEPARATOR_TYPEHASH = keccak256("EIP712Domain(uint256 chainId,address verifyingContract)");

    bytes32 private constant SAFE_TX_TYPEHASH =
        keccak256("SafeTx(address safe,address to,uint256 value,bytes data,uint8 operation,uint256 nonce)");
    bytes32 private constant RELAY_MSG_TYPEHASH =
        keccak256("RelayMsg(bytes32 safeTxHash,address gasToken,uint120 gasLimit,uint120 maxFeePerGas,address refundReceiver)");

    event SuccessfulExecution(bytes32 txHash, uint256 payment);

    struct RelayCondition {
        uint120 maxFeePerGas;
        uint120 maxGasLimit;
        uint16 allowedRelayersCount;
        mapping(address => bool) allowedRelayers;
    }

    struct SafeTx {
        address payable safe;
        address to;
        uint256 value;
        bytes data;
        SafeTransactionQueueConditionalRefund.Operation operation;
    }

    struct RelayParams {
        address gasToken;
        uint120 gasLimit;
        uint120 maxFeePerGas;
        address payable refundReceiver;
    }

    mapping(address => uint256) public safeNonces;
    // safeAdress -> tokenAddress -> RelayCondition
    mapping(address => mapping(address => RelayCondition)) public safeRelayConditions;

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, block.chainid, this));
    }

    /// @dev Sets the maximum boundary for the given safe and gas token. For legacy networks that don't support EIP1559 set both to equal amounts
    /// @param tokenAddress Refund token address
    /// @param maxFeePerGas Maximum fee
    /// @param maxGasLimit Maximum gas limit that can be refunded, includes base gas (gas independent of the transaction execution)
    /// @param relayerAllowlist Addresses of allowed relayers
    function setRelayCondition(
        address tokenAddress,
        uint120 maxFeePerGas,
        uint120 maxGasLimit,
        address[] calldata relayerAllowlist
    ) public {
        RelayCondition storage relayCondition = safeRelayConditions[msg.sender][tokenAddress];
        relayCondition.maxFeePerGas = maxFeePerGas;
        relayCondition.maxGasLimit = maxGasLimit;
        relayCondition.allowedRelayersCount = uint16(relayerAllowlist.length);

        unchecked {
            for (uint256 i = 0; i < relayerAllowlist.length; i++) relayCondition.allowedRelayers[relayerAllowlist[i]] = true;
        }
    }

    /// @dev Executes a transaction from the Safe if it has the required amount of signatures. No Refund logic is performed.
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
        RelayParams calldata relayParams,
        bytes memory relaySignature
    ) external payable {
        // initial gas = 21k + non_zero_bytes * 16 + zero_bytes * 4
        //            ~= 21k + calldata.length * [1/3 * 16 + 2/3 * 4]
        uint256 startGas = gasleft() + 21000 + msg.data.length * 8;
        if (startGas < relayParams.gasLimit) {
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

        // Relayer checks
        {
            bytes memory encodedRelayMsgData = encodeRelayMessageData(
                safeTxHash,
                relayParams.gasToken,
                relayParams.gasLimit,
                relayParams.maxFeePerGas,
                relayParams.refundReceiver
            );
            bytes32 relayMsgHash = keccak256(encodedRelayMsgData);
            GnosisSafe(safeTx.safe).checkNSignatures(relayMsgHash, encodedRelayMsgData, relaySignature, 1);
        }

        RelayCondition storage relayCondition = safeRelayConditions[safeTx.safe][relayParams.gasToken];
        // If an allowlist is enforced, check if the refundReceiver is allowed and doesnt equal to zero address
        if (
            relayCondition.allowedRelayersCount != 0 &&
            (relayCondition.allowedRelayers[relayParams.refundReceiver] == false || relayParams.refundReceiver == address(0))
        ) {
            revert InvalidRefundReceiver();
        }

        // Gas price and limit check
        if (relayParams.maxFeePerGas > relayCondition.maxFeePerGas || relayParams.gasLimit > relayCondition.maxGasLimit) {
            revert RelayGasPriceConditionsNotMet();
        }

        {
            execute(safeTx.safe, safeTx.to, safeTx.value, safeTx.data, safeTx.operation);

            uint256 payment = handleRefund(
                safeTx.safe,
                startGas,
                relayParams.gasLimit,
                relayParams.maxFeePerGas,
                relayParams.gasToken,
                relayParams.refundReceiver
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

    /// @dev Returns the relay message bytes to be signed by owners.
    /// @param safeTxHash Safe transaction hash
    /// @param gasToken Gas Token address
    /// @param maxFeePerGas Maximum fee
    /// @param refundReceiver Refund recipient address
    /// @return Relay message bytes
    function encodeRelayMessageData(
        bytes32 safeTxHash,
        address gasToken,
        uint120 gasLimit,
        uint120 maxFeePerGas,
        address refundReceiver
    ) public view returns (bytes memory) {
        bytes32 safeOperationHash = keccak256(abi.encode(RELAY_MSG_TYPEHASH, safeTxHash, gasToken, gasLimit, maxFeePerGas, refundReceiver));

        return abi.encodePacked(bytes1(0x19), bytes1(0x01), domainSeparator(), safeOperationHash);
    }

    /// @dev Returns the relay message hash to be signed by owners.
    /// @param safeTxHash Safe transaction hash
    /// @param gasToken Gas Token address
    /// @param gasLimit Transaction gas limit
    /// @param maxFeePerGas Maximum fee
    /// @param refundReceiver Refund recipient address
    /// @return Relay message hash
    function getRelayMessageHash(
        bytes32 safeTxHash,
        address gasToken,
        uint120 gasLimit,
        uint120 maxFeePerGas,
        address refundReceiver
    ) public view returns (bytes32) {
        return keccak256(encodeRelayMessageData(safeTxHash, gasToken, gasLimit, maxFeePerGas, refundReceiver));
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
     * @dev Returns the smallest of two numbers.
     */
    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a >= b ? b : a;
    }
}
